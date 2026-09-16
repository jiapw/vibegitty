use crate::config::{self, Account, AppConfig};
use crate::watcher::WatchHandle;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub watchers: Mutex<HashMap<String, WatchHandle>>,
    pub login_cancel: Arc<AtomicBool>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn load() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("VibeGitty/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            config: Mutex::new(config::load()),
            watchers: Mutex::new(HashMap::new()),
            login_cancel: Arc::new(AtomicBool::new(false)),
            http,
        }
    }

    pub fn config(&self) -> AppConfig {
        self.config.lock().clone()
    }

    pub fn settings(&self) -> config::Settings {
        self.config.lock().settings.clone()
    }

    /// Mutate the config and persist it.
    pub fn update<R>(&self, f: impl FnOnce(&mut AppConfig) -> R) -> R {
        let mut guard = self.config.lock();
        let r = f(&mut guard);
        if let Err(e) = config::save(&guard) {
            log::error!("failed to save config: {e}");
        }
        r
    }

    /// All accounts together with their secrets, for credential lookups.
    pub fn credentials(&self) -> CredSet {
        let accounts = self.config.lock().accounts.clone();
        let entries = accounts
            .into_iter()
            .filter_map(|a| crate::secrets::get_token(&a.id).map(|t| (a, t)))
            .collect();
        CredSet { entries }
    }
}

/// Accounts + tokens resolved for the duration of one network operation.
#[derive(Clone, Default)]
pub struct CredSet {
    pub entries: Vec<(Account, String)>,
}

impl CredSet {
    /// Find an account whose host matches the remote URL host.
    pub fn for_url(&self, url: &str) -> Option<(&Account, &str)> {
        let host = crate::git::remote::url_host(url)?;
        let host_l = host.to_ascii_lowercase();
        let bare = host_l.split(':').next().unwrap_or("").to_string();
        self.entries
            .iter()
            .find(|(a, _)| {
                let ah = a.host.to_ascii_lowercase();
                ah == host_l || ah.split(':').next() == Some(bare.as_str())
            })
            .map(|(a, t)| (a, t.as_str()))
    }
}
