//! Filesystem watcher that notifies the frontend when a repository changes on
//! disk (external edits, other git tools), debounced.

use crate::error::{AppError, AppResult};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn relevant(ev: &Event) -> bool {
    if !matches!(
        ev.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    ) {
        return false;
    }
    ev.paths.iter().any(|p| {
        let s = p.to_string_lossy().replace('\\', "/");
        !(s.ends_with(".lock")
            || s.contains("/.git/objects/")
            || s.contains("/.git/logs/")
            || s.contains("/.git/lfs/tmp")
            || s.contains("/.git/lfs/incomplete")
            || s.ends_with(".vibegitty-lfs-tmp"))
    })
}

pub fn watch(app: AppHandle, repo_path: String) -> AppResult<WatchHandle> {
    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| AppError::Msg(e.to_string()))?;
    watcher
        .watch(Path::new(&repo_path), RecursiveMode::Recursive)
        .map_err(|e| AppError::Msg(format!("cannot watch {repo_path}: {e}")))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let key = repo_path.clone();
    std::thread::Builder::new()
        .name("repo-watcher".into())
        .spawn(move || {
            let mut pending = false;
            let mut last = Instant::now();
            loop {
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Ok(ev)) => {
                        if relevant(&ev) {
                            pending = true;
                            last = Instant::now();
                        }
                    }
                    Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if pending && last.elapsed() >= Duration::from_millis(500) {
                    pending = false;
                    let _ = app.emit("repo-changed", serde_json::json!({ "repo": key }));
                }
            }
        })
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(WatchHandle {
        _watcher: watcher,
        stop,
    })
}
