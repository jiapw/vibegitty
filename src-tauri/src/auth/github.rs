//! GitHub sign-in. Two flows:
//! - web application flow: the user authorizes on github.com and is sent back
//!   to a loopback redirect; GitHub requires the OAuth App's client secret to
//!   exchange the code, so this needs a secret compiled in or configured;
//! - device flow (RFC 8628): a one-time code, no secret; the OAuth App must
//!   have "Device Flow" enabled. Used when no secret is available.

use super::{emit_status, finish_login, open_browser, provider_meta, status, AuthStatus};
use crate::config::{Account, Provider};
use crate::error::{err, AppResult};
use crate::state::AppState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const SCOPES: &str = "repo read:user user:email workflow";

/// Browser sign-in through GitHub's web application flow.
pub async fn web_login(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    client_secret: &str,
    base_url: &str,
) -> AppResult<Account> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return err("GitHub browser sign-in needs an OAuth App client id and client secret.");
    }
    let cancel = state.login_cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let meta = provider_meta(Provider::Github, base_url)?;
    let port = state.settings().oauth_redirect_port;
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let listener = super::oauth::bind_loopback(port)?;
    let state_str = super::oauth::random_token(24);

    let mut url = url::Url::parse(&format!("{}/login/oauth/authorize", meta.web_base))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("scope", SCOPES)
        .append_pair("state", &state_str);

    emit_status(
        app,
        AuthStatus {
            stage: "browser".into(),
            user_code: None,
            verification_uri: Some(url.to_string()),
            expires_in: Some(300),
            message: None,
        },
    );
    open_browser(app, url.as_str());

    let code = match super::oauth::wait_for_code(app.clone(), listener, cancel, state_str).await {
        Ok(c) => c,
        Err(e) => {
            emit_status(app, status("error"));
            return Err(e);
        }
    };

    let tok: Value = state
        .http
        .post(format!("{}/login/oauth/access_token", meta.web_base))
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code.as_str()),
            ("redirect_uri", redirect.as_str()),
        ])
        .send()
        .await?
        .json()
        .await?;
    if let Some(t) = tok["access_token"].as_str() {
        let token = t.to_string();
        return finish_login(app, state, Provider::Github, meta, "oauth", "", &token).await;
    }
    emit_status(app, status("error"));
    let desc = tok["error_description"].as_str().unwrap_or("").to_string();
    match tok["error"].as_str() {
        Some("incorrect_client_credentials") => err("GitHub rejected the OAuth App client id or client secret."),
        Some("redirect_uri_mismatch") => err(format!(
            "The OAuth App's authorization callback URL must be {redirect} (or http://127.0.0.1/callback). {desc}"
        )),
        Some(other) => err(format!("{other}: {desc}")),
        None => err(format!("Unexpected token response: {tok}")),
    }
}

/// Device-code sign-in; the fallback when no client secret is available.
pub async fn device_login(app: &AppHandle, state: &AppState, client_id: &str, base_url: &str) -> AppResult<Account> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return err("A GitHub OAuth App client id is required (Settings > GitHub client id). Create one at github.com/settings/developers and enable Device Flow.");
    }
    let cancel = state.login_cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let meta = provider_meta(Provider::Github, base_url)?;
    let http = state.http.clone();

    let resp: Value = http
        .post(format!("{}/login/device/code", meta.web_base))
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", SCOPES)])
        .send()
        .await?
        .error_for_status()
        .map_err(|e| format!("GitHub device flow request failed: {e}"))?
        .json()
        .await?;

    let device_code = resp["device_code"]
        .as_str()
        .ok_or_else(|| format!("Unexpected device flow response: {resp}"))?
        .to_string();
    let user_code = resp["user_code"].as_str().unwrap_or("").to_string();
    let verification_uri = resp["verification_uri"]
        .as_str()
        .unwrap_or("https://github.com/login/device")
        .to_string();
    let mut interval = resp["interval"].as_u64().unwrap_or(5).max(1);
    let expires_in = resp["expires_in"].as_u64().unwrap_or(900);

    emit_status(
        app,
        AuthStatus {
            stage: "device_code".into(),
            user_code: Some(user_code),
            verification_uri: Some(verification_uri.clone()),
            expires_in: Some(expires_in),
            message: None,
        },
    );
    open_browser(app, &verification_uri);

    let deadline = Instant::now() + Duration::from_secs(expires_in);
    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_status(app, status("error"));
            return err("Login cancelled");
        }
        if Instant::now() > deadline {
            emit_status(app, status("error"));
            return err("The device code expired. Please try again.");
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if cancel.load(Ordering::Relaxed) {
            emit_status(app, status("error"));
            return err("Login cancelled");
        }
        let tok: Value = http
            .post(format!("{}/login/oauth/access_token", meta.web_base))
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?
            .json()
            .await?;
        if let Some(t) = tok["access_token"].as_str() {
            let token = t.to_string();
            return finish_login(app, state, Provider::Github, meta, "oauth", "", &token).await;
        }
        match tok["error"].as_str() {
            Some("authorization_pending") => continue,
            Some("slow_down") => interval += 5,
            Some("expired_token") => {
                emit_status(app, status("error"));
                return err("The device code expired. Please try again.");
            }
            Some("access_denied") => {
                emit_status(app, status("error"));
                return err("Access was denied in the browser.");
            }
            Some(other) => {
                emit_status(app, status("error"));
                return err(format!(
                    "{other}: {}",
                    tok["error_description"].as_str().unwrap_or("")
                ));
            }
            None => {
                emit_status(app, status("error"));
                return err(format!("Unexpected token response: {tok}"));
            }
        }
    }
}
