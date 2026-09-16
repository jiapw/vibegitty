use super::types::*;
use super::*;
use git2::{Delta, DiffFile, Repository, RepositoryState, Status, StatusOptions};

pub fn delta_status_str(d: Delta) -> &'static str {
    match d {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Untracked => "untracked",
        Delta::Conflicted => "conflicted",
        Delta::Ignored => "ignored",
        Delta::Unmodified => "unmodified",
        Delta::Unreadable => "unreadable",
    }
}

fn file_path(f: DiffFile<'_>) -> String {
    path_str(f.path())
}

/// Every directory that contains at least one index (tracked) entry.
fn tracked_dirs(repo: &Repository) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(index) = repo.index() {
        for e in index.iter() {
            let p = String::from_utf8_lossy(&e.path).replace('\\', "/");
            let mut s: &str = &p;
            while let Some(i) = s.rfind('/') {
                let d = &s[..i];
                if !set.insert(d.to_string()) {
                    break; // ancestors were added with an earlier entry
                }
                s = d;
            }
        }
    }
    set
}

/// Deepest ancestor directory of `path` that contains tracked files.
fn tracked_parent(dirs: &std::collections::HashSet<String>, path: &str) -> Option<String> {
    let mut s = path;
    while let Some(i) = s.rfind('/') {
        let d = &s[..i];
        if dirs.contains(d) {
            return Some(d.to_string());
        }
        s = d;
    }
    None
}

pub fn working_status(repo: &Repository) -> AppResult<WorkingStatus> {
    let wd = workdir(repo)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false)
        .include_unmodified(false)
        .exclude_submodules(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    let lfs_on = crate::lfs::repo_uses_lfs(repo);

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicted = Vec::new();
    let mut lfs_recheck: Vec<String> = Vec::new();
    let mut tracked: Option<std::collections::HashSet<String>> = None;

    const INDEX_MASK: Status = Status::INDEX_NEW
        .union(Status::INDEX_MODIFIED)
        .union(Status::INDEX_DELETED)
        .union(Status::INDEX_RENAMED)
        .union(Status::INDEX_TYPECHANGE);
    const WT_MASK: Status = Status::WT_NEW
        .union(Status::WT_MODIFIED)
        .union(Status::WT_DELETED)
        .union(Status::WT_RENAMED)
        .union(Status::WT_TYPECHANGE);

    for e in statuses.iter() {
        let s = e.status();
        let path = e.path().unwrap_or("").replace('\\', "/");
        if s.is_conflicted() {
            let size = std::fs::metadata(wd.join(&path)).map(|m| m.len()).unwrap_or(0);
            conflicted.push(StatusEntry {
                path,
                old_path: None,
                status: "conflicted".into(),
                is_lfs: false,
                size,
                tracked_parent: None,
            });
            continue;
        }
        if s.intersects(INDEX_MASK) {
            let (p, old, st) = match e.head_to_index() {
                Some(d) => {
                    let old = if d.status() == Delta::Renamed || d.status() == Delta::Copied {
                        Some(file_path(d.old_file()))
                    } else {
                        None
                    };
                    (file_path(d.new_file()), old, delta_status_str(d.status()))
                }
                None => (path.clone(), None, "modified"),
            };
            let is_lfs = lfs_on && crate::lfs::is_lfs_path(repo, &p);
            staged.push(StatusEntry {
                path: p,
                old_path: old,
                status: st.into(),
                is_lfs,
                size: 0,
                tracked_parent: None,
            });
        }
        if s.intersects(WT_MASK) {
            let (p, old, st) = match e.index_to_workdir() {
                Some(d) => {
                    let old = if d.status() == Delta::Renamed || d.status() == Delta::Copied {
                        Some(file_path(d.old_file()))
                    } else {
                        None
                    };
                    (file_path(d.new_file()), old, delta_status_str(d.status()))
                }
                None => (path.clone(), None, "modified"),
            };
            let st = if s.contains(Status::WT_NEW) { "untracked" } else { st };
            let size = std::fs::metadata(wd.join(&p)).map(|m| m.len()).unwrap_or(0);
            let is_lfs = lfs_on && crate::lfs::is_lfs_path(repo, &p);
            if is_lfs && s.contains(Status::WT_MODIFIED) {
                lfs_recheck.push(p.clone());
            }
            let tp = if st == "untracked" {
                let dirs = tracked.get_or_insert_with(|| tracked_dirs(repo));
                tracked_parent(dirs, &p)
            } else {
                None
            };
            unstaged.push(StatusEntry {
                path: p,
                old_path: old,
                status: st.into(),
                is_lfs,
                size,
                tracked_parent: tp,
            });
        }
    }

    // LFS: libgit2 has no clean filter, so a smudged LFS file looks modified
    // until its stat cache is refreshed. Re-hash those and drop false positives.
    if !lfs_recheck.is_empty() {
        match crate::lfs::verify_unmodified(repo, &lfs_recheck) {
            Ok(clean) if !clean.is_empty() => unstaged.retain(|e| !clean.contains(&e.path)),
            Ok(_) => {}
            Err(e) => ::log::warn!("lfs status recheck failed: {e}"),
        }
    }

    let sort = |v: &mut Vec<StatusEntry>| v.sort_by(|a, b| a.path.cmp(&b.path));
    sort(&mut staged);
    sort(&mut unstaged);
    sort(&mut conflicted);

    let state = state_name(repo.state()).to_string();
    let mut merge_heads = Vec::new();
    if repo.state() == RepositoryState::Merge {
        merge_heads = super::merge_heads(repo).iter().map(|o| o.to_string()).collect();
    }
    let merge_message = if repo.state() != RepositoryState::Clean {
        std::fs::read_to_string(repo.path().join("MERGE_MSG"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok(WorkingStatus {
        staged,
        unstaged,
        conflicted,
        state,
        merge_message,
        merge_heads,
    })
}
