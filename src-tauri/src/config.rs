use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
    Gitea,
    Bitbucket,
    Generic,
}

/// A connected hosting account. The secret (token / password) lives in the
/// OS keychain (see `secrets.rs`), keyed by `id`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    /// Host (with optional port) used to match git remote URLs, e.g. `github.com`.
    pub host: String,
    /// REST API base, e.g. `https://api.github.com` or `https://gitlab.com/api/v4`.
    pub api_base: String,
    /// Web base, e.g. `https://github.com`.
    pub web_base: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// Username to send with the token for git-over-HTTPS (`oauth2` for GitLab OAuth).
    pub token_username: String,
    /// `oauth` | `token` | `basic`
    pub auth_kind: String,
}

/// GitHub OAuth App client id compiled into the binary (public information,
/// used for the device flow against github.com). Override at build time with
/// `VIBEGITTY_GITHUB_CLIENT_ID`; GitHub Enterprise servers need their own id,
/// entered in the sign-in dialog.
pub const BUILTIN_GITHUB_CLIENT_ID: &str = match option_env!("VIBEGITTY_GITHUB_CLIENT_ID") {
    Some(v) => v,
    None => "Ov23ligJhKUai9khsvz6",
};

pub fn builtin_github_client_id() -> Option<&'static str> {
    let id = BUILTIN_GITHUB_CLIENT_ID.trim();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Client secret matching the built-in client id, compiled in from
/// `VIBEGITTY_GITHUB_CLIENT_SECRET` (see build.rs). With it GitHub sign-in
/// completes in the browser; without it the device flow is used.
pub const BUILTIN_GITHUB_CLIENT_SECRET: &str = match option_env!("VIBEGITTY_GITHUB_CLIENT_SECRET") {
    Some(v) => v,
    None => "",
};

pub fn builtin_github_client_secret() -> Option<&'static str> {
    let s = BUILTIN_GITHUB_CLIENT_SECRET.trim();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub author_name: String,
    pub author_email: String,
    /// Optional GitHub OAuth App client id overriding the built-in one.
    pub github_client_id: String,
    /// Client secret for that id; enables the browser flow instead of device codes.
    pub github_client_secret: String,
    /// Loopback port used for PKCE redirects (GitLab / Gitea).
    pub oauth_redirect_port: u16,
    pub default_clone_dir: String,
    pub commit_page_size: usize,
    pub large_file_warn_mb: u64,
    /// `system` | `dark` | `light`
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            author_name: String::new(),
            author_email: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            oauth_redirect_port: 47831,
            default_clone_dir: String::new(),
            commit_page_size: 400,
            large_file_warn_mb: 50,
            theme: "dark".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub open_repos: Vec<String>,
    pub active_repo: Option<String>,
    pub recent_repos: Vec<String>,
    pub accounts: Vec<Account>,
    pub settings: Settings,
    /// Frontend layout preferences (panel widths, list/diff modes, split
    /// ratios, collapsed sections). Opaque to the backend.
    pub ui: serde_json::Map<String, serde_json::Value>,
}

/// Portable ("green") mode: when a `VibeGittyData` folder or a `portable.txt`
/// marker exists next to the executable, settings and tokens live there
/// instead of the user profile / OS keychain, so the exe can be carried around.
pub fn portable_dir() -> Option<PathBuf> {
    static PORTABLE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    PORTABLE
        .get_or_init(|| {
            let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            let data = exe_dir.join("VibeGittyData");
            let legacy = exe_dir.join("GitConnData");
            if data.is_dir() || exe_dir.join("portable.txt").is_file() {
                std::fs::create_dir_all(&data).ok()?;
                Some(data)
            } else if legacy.is_dir() {
                // Data folder from the app's previous name keeps working.
                Some(legacy)
            } else {
                None
            }
        })
        .clone()
}

pub fn is_portable() -> bool {
    portable_dir().is_some()
}

pub fn config_dir() -> PathBuf {
    if let Some(p) = portable_dir() {
        return p;
    }
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("VibeGitty");
    // One-time migration from the app's previous name.
    let legacy = base.join("GitConn");
    if !dir.exists() && legacy.is_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            for name in ["config.json", "secrets.json"] {
                let _ = std::fs::copy(legacy.join(name), dir.join(name));
            }
        }
    }
    dir
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load() -> AppConfig {
    let path = config_path();
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("config parse error ({e}); using defaults");
            AppConfig::default()
        }),
        Err(_) => AppConfig::default(),
    }
}

pub fn save(cfg: &AppConfig) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join("config.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
    std::fs::rename(&tmp, config_path())?;
    Ok(())
}
