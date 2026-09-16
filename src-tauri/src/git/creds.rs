//! Credential resolution and progress reporting for network operations.

use super::types::ProgressEvent;
use crate::state::CredSet;
use git2::{CertificateCheckStatus, Cred, CredentialType, RemoteCallbacks};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub type ProgressSink = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// Everything a network operation needs: where to report progress, which
/// repository it concerns, and the credentials available to it.
#[derive(Clone)]
pub struct OpContext {
    pub sink: ProgressSink,
    pub repo: String,
    pub op: String,
    pub creds: Arc<CredSet>,
}

impl OpContext {
    pub fn new(app: AppHandle, repo: &str, op: &str, creds: CredSet) -> Self {
        Self {
            sink: Arc::new(move |ev| emit(&app, ev)),
            repo: repo.to_string(),
            op: op.to_string(),
            creds: Arc::new(creds),
        }
    }

    /// Context without a UI (tests, headless use).
    pub fn silent(repo: &str, op: &str, creds: CredSet) -> Self {
        Self {
            sink: Arc::new(|_| {}),
            repo: repo.to_string(),
            op: op.to_string(),
            creds: Arc::new(creds),
        }
    }

    pub fn progress(&self, phase: &str, current: u64, total: u64, bytes: u64, message: Option<String>) {
        (self.sink)(ProgressEvent {
            repo: self.repo.clone(),
            op: self.op.clone(),
            phase: phase.to_string(),
            current,
            total,
            bytes,
            message,
            done: false,
        });
    }

    pub fn done(&self, message: Option<String>) {
        (self.sink)(ProgressEvent {
            repo: self.repo.clone(),
            op: self.op.clone(),
            phase: "done".into(),
            current: 0,
            total: 0,
            bytes: 0,
            message,
            done: true,
        });
    }
}

pub fn emit(app: &AppHandle, ev: ProgressEvent) {
    let _ = app.emit("git-progress", ev);
}

fn ssh_key_candidates() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let ssh = home.join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk"]
        .iter()
        .map(|n| ssh.join(n))
        .collect()
}

pub fn callbacks<'a>(ctx: &OpContext) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();

    let creds = ctx.creds.clone();
    let keys = ssh_key_candidates();
    let mut attempts = 0u32;
    let mut tried_account = false;
    let mut tried_helper = false;
    let mut tried_agent = false;
    let mut key_idx = 0usize;
    cb.credentials(move |url, username_from_url, allowed| {
        attempts += 1;
        if attempts > 8 {
            return Err(git2::Error::from_str("Authentication failed after several attempts"));
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if !tried_account {
                tried_account = true;
                if let Some((acct, token)) = creds.for_url(url) {
                    let user = if acct.token_username.is_empty() {
                        acct.username.clone()
                    } else {
                        acct.token_username.clone()
                    };
                    return Cred::userpass_plaintext(&user, token);
                }
            }
            if !tried_helper {
                tried_helper = true;
                // Optional: an already-configured git credential helper. Never required.
                if let Ok(cfg) = git2::Config::open_default() {
                    if let Ok(c) = Cred::credential_helper(&cfg, url, username_from_url) {
                        return Ok(c);
                    }
                }
            }
            let host = super::remote::url_host(url).unwrap_or_else(|| url.to_string());
            return Err(git2::Error::from_str(&format!(
                "No valid credentials for {host}. Connect an account for this host (Accounts) or check the token permissions."
            )));
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            let user = username_from_url.unwrap_or("git");
            if !tried_agent {
                tried_agent = true;
                if let Ok(c) = Cred::ssh_key_from_agent(user) {
                    return Ok(c);
                }
            }
            while key_idx < keys.len() {
                let key = keys[key_idx].clone();
                key_idx += 1;
                if key.exists() {
                    let pubkey = key.with_extension("pub");
                    let pubkey = if pubkey.exists() { Some(pubkey) } else { None };
                    return Cred::ssh_key(user, pubkey.as_deref(), &key, None);
                }
            }
            return Err(git2::Error::from_str(
                "SSH authentication failed: no key accepted from ssh-agent or ~/.ssh (id_ed25519, id_ecdsa, id_rsa). Passphrase-protected keys must be loaded into ssh-agent.",
            ));
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str("Unsupported authentication method requested by the server"))
    });

    // TLS certificates are validated by libgit2; SSH host keys are accepted on
    // first use (like `StrictHostKeyChecking=accept-new`).
    cb.certificate_check(|cert, _host| {
        if cert.as_hostkey().is_some() {
            Ok(CertificateCheckStatus::CertificateOk)
        } else {
            Ok(CertificateCheckStatus::CertificatePassthrough)
        }
    });

    let c1 = ctx.clone();
    let mut last = Instant::now() - Duration::from_secs(1);
    cb.transfer_progress(move |p| {
        let receiving = p.received_objects() < p.total_objects();
        if last.elapsed() >= Duration::from_millis(80) || !receiving {
            last = Instant::now();
            let (phase, current) = if receiving {
                ("receiving", p.received_objects())
            } else {
                ("indexing", p.indexed_objects())
            };
            c1.progress(phase, current as u64, p.total_objects() as u64, p.received_bytes() as u64, None);
        }
        true
    });

    let c2 = ctx.clone();
    cb.sideband_progress(move |data| {
        let msg = String::from_utf8_lossy(data).trim().to_string();
        if !msg.is_empty() {
            c2.progress("remote", 0, 0, 0, Some(msg));
        }
        true
    });

    let c3 = ctx.clone();
    let mut last3 = Instant::now() - Duration::from_secs(1);
    cb.push_transfer_progress(move |current, total, bytes| {
        if last3.elapsed() >= Duration::from_millis(80) || current == total {
            last3 = Instant::now();
            c3.progress("pushing", current as u64, total as u64, bytes as u64, None);
        }
    });

    cb.push_update_reference(|refname, status| match status {
        Some(s) => Err(git2::Error::from_str(&format!("{refname}: {s}"))),
        None => Ok(()),
    });

    cb
}
