//! Hosting accounts: GitHub OAuth (device flow), GitLab/Gitea OAuth (PKCE with
//! a loopback redirect), and token / basic-auth logins for any git server.

pub mod api;
pub mod github;
pub mod oauth;

use crate::config::{Account, Provider};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// device_code | browser | waiting | done | error
    pub stage: String,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub expires_in: Option<u64>,
    pub message: Option<String>,
}

pub fn emit_status(app: &AppHandle, status: AuthStatus) {
    let _ = app.emit("auth-status", status);
}

pub fn status(stage: &str) -> AuthStatus {
    AuthStatus {
        stage: stage.into(),
        user_code: None,
        verification_uri: None,
        expires_in: None,
        message: None,
    }
}

#[derive(Clone, Debug)]
pub struct ProviderMeta {
    pub host: String,
    pub api_base: String,
    pub web_base: String,
}

pub fn provider_meta(provider: Provider, base_url: &str) -> AppResult<ProviderMeta> {
    let default = match provider {
        Provider::Github => "https://github.com",
        Provider::Gitlab => "https://gitlab.com",
        Provider::Bitbucket => "https://bitbucket.org",
        Provider::Gitea | Provider::Generic => "",
    };
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { default } else { base };
    if base.is_empty() {
        return Err(AppError::Msg("Server URL is required".into()));
    }
    let base = if base.contains("://") {
        base.to_string()
    } else {
        format!("https://{base}")
    };
    let u = url::Url::parse(&base)?;
    let host = match (u.host_str(), u.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => return Err(AppError::Msg("Invalid server URL".into())),
    };
    let web_base = format!("{}://{}", u.scheme(), host);
    let path = u.path().trim_end_matches('/');
    let web_base = if path.is_empty() { web_base } else { format!("{web_base}{path}") };
    let api_base = match provider {
        Provider::Github => {
            if host.eq_ignore_ascii_case("github.com") {
                "https://api.github.com".to_string()
            } else {
                format!("{web_base}/api/v3")
            }
        }
        Provider::Gitlab => format!("{web_base}/api/v4"),
        Provider::Gitea => format!("{web_base}/api/v1"),
        Provider::Bitbucket => "https://api.bitbucket.org/2.0".to_string(),
        Provider::Generic => web_base.clone(),
    };
    Ok(ProviderMeta {
        host,
        api_base,
        web_base,
    })
}

/// Validate the token against the provider API, then persist the account.
pub async fn finish_login(
    app: &AppHandle,
    state: &AppState,
    provider: Provider,
    meta: ProviderMeta,
    auth_kind: &str,
    username_hint: &str,
    token: &str,
) -> AppResult<Account> {
    emit_status(app, status("waiting"));
    let profile = api::fetch_profile(&state.http, provider, &meta, username_hint, token).await?;
    let token_username = match (provider, auth_kind) {
        (Provider::Gitlab, "oauth") => "oauth2".to_string(),
        (Provider::Gitea, "oauth") => "oauth2".to_string(),
        _ => profile.username.clone(),
    };
    let existing = state
        .config()
        .accounts
        .into_iter()
        .find(|a| a.host.eq_ignore_ascii_case(&meta.host) && a.username == profile.username);
    let id = existing
        .map(|a| a.id)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let account = Account {
        id: id.clone(),
        provider,
        host: meta.host,
        api_base: meta.api_base,
        web_base: meta.web_base,
        username: profile.username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        token_username,
        auth_kind: auth_kind.to_string(),
    };
    crate::secrets::set_token(&id, token);
    let acc = account.clone();
    state.update(move |c| {
        c.accounts.retain(|a| a.id != acc.id);
        c.accounts.push(acc);
    });
    emit_status(app, status("done"));
    focus_main_window(app);
    Ok(account)
}

/// Bring the app back in front once a browser-based sign-in has finished.
pub fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn remove_account(state: &AppState, id: &str) {
    crate::secrets::delete_token(id);
    state.update(|c| c.accounts.retain(|a| a.id != id));
}

pub fn open_browser(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        log::warn!("cannot open browser: {e}");
    }
}
