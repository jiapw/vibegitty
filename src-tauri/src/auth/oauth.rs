//! OAuth 2.0 authorization-code flow with PKCE and a loopback redirect
//! (`http://127.0.0.1:<port>/callback`), used for GitLab and Gitea/Forgejo.

use super::{emit_status, finish_login, open_browser, provider_meta, status, AuthStatus};
use crate::config::{Account, Provider};
use crate::error::{blocking, err, AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use rand::Rng;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub(crate) fn random_token(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

const CALLBACK_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>VibeGitty</title>
<style>body{font-family:system-ui,sans-serif;background:#15181e;color:#d6dce6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1f242c;border:1px solid #2f3541;border-radius:12px;padding:32px 40px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#8a93a3}</style></head>
<body><div class="card"><h1>VibeGitty: login complete</h1><p>Return to the app; this tab can be closed.</p></div>
<script>setTimeout(function(){window.close()},600)</script></body></html>"#;

fn http_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// Listen on the loopback redirect port, or explain how to fix a clash.
pub(crate) fn bind_loopback(port: u16) -> AppResult<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        AppError::Msg(format!(
            "Cannot listen on 127.0.0.1:{port} ({e}). Change the OAuth redirect port in Settings and register the same port in the OAuth application."
        ))
    })?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Wait (up to 5 minutes) for the browser redirect carrying `code`.
pub(crate) async fn wait_for_code(listener: TcpListener, cancel: Arc<AtomicBool>, expected_state: String) -> AppResult<String> {
    blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            if cancel.load(Ordering::Relaxed) {
                return err("Login cancelled");
            }
            if Instant::now() > deadline {
                return err("Timed out waiting for the browser login");
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = text.lines().next().unwrap_or("").to_string();
                    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                    if !path.starts_with("/callback") {
                        let _ = stream.write_all(http_response("<h1>VibeGitty</h1>").as_bytes());
                        continue;
                    }
                    let url = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
                    let mut code = None;
                    let mut st = None;
                    let mut error = None;
                    for (k, v) in url.query_pairs() {
                        match k.as_ref() {
                            "code" => code = Some(v.to_string()),
                            "state" => st = Some(v.to_string()),
                            "error" | "error_description" => error = Some(v.to_string()),
                            _ => {}
                        }
                    }
                    let _ = stream.write_all(http_response(CALLBACK_HTML).as_bytes());
                    let _ = stream.flush();
                    if let Some(e) = error {
                        return err(format!("Authorization failed: {e}"));
                    }
                    if st.as_deref() != Some(expected_state.as_str()) {
                        return err("OAuth state mismatch; please try again");
                    }
                    return code.ok_or_else(|| AppError::Msg("No authorization code received".into()));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(e.into()),
            }
        }
    })
    .await
}

pub async fn pkce_login(
    app: &AppHandle,
    state: &AppState,
    provider: Provider,
    base_url: &str,
    client_id: &str,
) -> AppResult<Account> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return err("An OAuth application id is required");
    }
    let meta = provider_meta(provider, base_url)?;
    let port = state.settings().oauth_redirect_port;
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token(64);
    let challenge = pkce_challenge(&verifier);
    let state_str = random_token(24);

    let (authorize, token_url, scope) = match provider {
        Provider::Gitlab => (
            format!("{}/oauth/authorize", meta.web_base),
            format!("{}/oauth/token", meta.web_base),
            Some("api read_user"),
        ),
        Provider::Gitea => (
            format!("{}/login/oauth/authorize", meta.web_base),
            format!("{}/login/oauth/access_token", meta.web_base),
            None,
        ),
        _ => return err("Browser (PKCE) login is available for GitLab and Gitea/Forgejo. Use a token for other servers."),
    };

    let mut url = url::Url::parse(&authorize)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("state", &state_str)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(s) = scope {
            q.append_pair("scope", s);
        }
    }

    let cancel = state.login_cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let listener = bind_loopback(port)?;

    emit_status(
        app,
        AuthStatus {
            stage: "browser".into(),
            user_code: None,
            verification_uri: Some(url.to_string()),
            expires_in: Some(300),
            message: Some(format!("Redirect URI: {redirect}")),
        },
    );
    open_browser(app, url.as_str());

    let code = match wait_for_code(listener, cancel, state_str).await {
        Ok(c) => c,
        Err(e) => {
            emit_status(app, status("error"));
            return Err(e);
        }
    };

    let tok: Value = state
        .http
        .post(&token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .json()
        .await?;
    let Some(access) = tok["access_token"].as_str() else {
        emit_status(app, status("error"));
        return err(format!("Token exchange failed: {tok}"));
    };
    let token = access.to_string();
    finish_login(app, state, provider, meta, "oauth", "", &token).await
}
