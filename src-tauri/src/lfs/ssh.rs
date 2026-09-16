//! `git-lfs-authenticate` over SSH, implemented with libssh2 (no `ssh` binary).

use crate::error::{AppError, AppResult};
use git_lfs_api::{ApiError, SshAuth, SshOperation, SshResolver};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct SshTarget {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub path: String,
}

pub struct Ssh2Resolver {
    target: SshTarget,
    cache: Mutex<HashMap<SshOperation, (SshAuth, Instant)>>,
}

impl Ssh2Resolver {
    pub fn new(target: SshTarget) -> Self {
        Self {
            target,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl SshResolver for Ssh2Resolver {
    fn resolve(&self, operation: SshOperation) -> Result<SshAuth, ApiError> {
        if let Some((auth, at)) = self.cache.lock().get(&operation) {
            if at.elapsed() < Duration::from_secs(240) {
                return Ok(auth.clone());
            }
        }
        let auth = authenticate(&self.target, operation).map_err(|e| ApiError::Decode(format!("git-lfs-authenticate: {e}")))?;
        self.cache.lock().insert(operation, (auth.clone(), Instant::now()));
        Ok(auth)
    }
}

fn key_candidates() -> Vec<std::path::PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let ssh = home.join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| ssh.join(n)).collect()
}

pub fn authenticate(t: &SshTarget, op: SshOperation) -> AppResult<SshAuth> {
    let tcp = TcpStream::connect((t.host.as_str(), t.port))
        .map_err(|e| AppError::Lfs(format!("cannot connect to {}:{}: {e}", t.host, t.port)))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut sess = ssh2::Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.handshake()?;

    if let Ok(mut agent) = sess.agent() {
        if agent.connect().is_ok() && agent.list_identities().is_ok() {
            for id in agent.identities().unwrap_or_default() {
                if agent.userauth(&t.user, &id).is_ok() && sess.authenticated() {
                    break;
                }
            }
        }
    }
    if !sess.authenticated() {
        for key in key_candidates() {
            if !key.exists() {
                continue;
            }
            let pubkey = key.with_extension("pub");
            let pubkey = if pubkey.exists() { Some(pubkey) } else { None };
            if sess
                .userauth_pubkey_file(&t.user, pubkey.as_deref(), &key, None)
                .is_ok()
                && sess.authenticated()
            {
                break;
            }
        }
    }
    if !sess.authenticated() {
        return Err(AppError::Lfs(format!(
            "SSH authentication to {} failed (ssh-agent / ~/.ssh keys)",
            t.host
        )));
    }

    let mut ch = sess.channel_session()?;
    let opname = match op {
        SshOperation::Upload => "upload",
        SshOperation::Download => "download",
    };
    ch.exec(&format!("git-lfs-authenticate {} {}", t.path, opname))?;
    let mut out = String::new();
    ch.read_to_string(&mut out)?;
    let mut err = String::new();
    let _ = ch.stderr().read_to_string(&mut err);
    let _ = ch.wait_close();
    let status = ch.exit_status().unwrap_or(0);
    if status != 0 || out.trim().is_empty() {
        return Err(AppError::Lfs(format!(
            "git-lfs-authenticate failed (exit {status}): {}",
            err.trim()
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&out)
        .map_err(|e| AppError::Lfs(format!("git-lfs-authenticate returned invalid JSON: {e}")))?;
    let href = v["href"].as_str().unwrap_or("").to_string();
    let headers = v["header"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(SshAuth { href, headers })
}
