//! Token storage: OS keychain (Windows Credential Manager, macOS Keychain,
//! Linux Secret Service) with a file fallback when no keychain is available.

use std::collections::HashMap;
use std::path::PathBuf;

const SERVICE: &str = "com.artsq.vibegitty";
/// Keychain service name used before the app was renamed; read as a fallback.
const LEGACY_SERVICE: &str = "com.artsq.gitconn";

fn fallback_path() -> PathBuf {
    crate::config::config_dir().join("secrets.json")
}

fn file_read() -> HashMap<String, String> {
    std::fs::read(fallback_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn file_write(map: &HashMap<String, String>) {
    let dir = crate::config::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(bytes) = serde_json::to_vec_pretty(map) {
        let _ = std::fs::write(fallback_path(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(fallback_path(), std::fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn set_token(id: &str, token: &str) {
    if crate::config::is_portable() {
        // Portable mode keeps everything next to the executable.
        let mut map = file_read();
        map.insert(id.to_string(), token.to_string());
        file_write(&map);
        return;
    }
    match keyring::Entry::new(SERVICE, id).and_then(|e| e.set_password(token)) {
        Ok(()) => {
            // Drop the other copies so an older token can never shadow this one.
            if let Ok(entry) = keyring::Entry::new(LEGACY_SERVICE, id) {
                let _ = entry.delete_credential();
            }
            let mut map = file_read();
            if map.remove(id).is_some() {
                file_write(&map);
            }
        }
        Err(e) => {
            log::warn!("keychain unavailable ({e}); storing token in {}", fallback_path().display());
            let mut map = file_read();
            map.insert(id.to_string(), token.to_string());
            file_write(&map);
        }
    }
}

pub fn get_token(id: &str) -> Option<String> {
    if crate::config::is_portable() {
        return file_read().get(id).cloned();
    }
    if let Ok(p) = keyring::Entry::new(SERVICE, id).and_then(|e| e.get_password()) {
        return Some(p);
    }
    // A token saved by the app under its old name: move it to the current
    // service so it is stored and looked up in one place from now on.
    if let Ok(p) = keyring::Entry::new(LEGACY_SERVICE, id).and_then(|e| e.get_password()) {
        if keyring::Entry::new(SERVICE, id).and_then(|e| e.set_password(&p)).is_ok() {
            if let Ok(entry) = keyring::Entry::new(LEGACY_SERVICE, id) {
                let _ = entry.delete_credential();
            }
        }
        return Some(p);
    }
    file_read().get(id).cloned()
}

pub fn delete_token(id: &str) {
    if !crate::config::is_portable() {
        if let Ok(entry) = keyring::Entry::new(SERVICE, id) {
            let _ = entry.delete_credential();
        }
    }
    let mut map = file_read();
    if map.remove(id).is_some() {
        file_write(&map);
    }
}
