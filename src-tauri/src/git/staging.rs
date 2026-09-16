use super::*;
use git2::build::CheckoutBuilder;
use git2::{ObjectType, Repository};
use std::path::Path;

/// Status lists a move as one `renamed` entry (old path -> new path). Operations
/// on such an entry must touch both paths, otherwise the other half stays
/// behind as a phantom "deleted" file. `staged` selects which list to consult.
pub fn expand_renames(repo: &Repository, paths: &[String], staged: bool) -> AppResult<Vec<String>> {
    let st = super::status::working_status(repo)?;
    let list = if staged { &st.staged } else { &st.unstaged };
    let mut out: Vec<String> = paths.to_vec();
    for p in paths {
        if let Some(e) = list.iter().find(|e| &e.path == p) {
            if let Some(old) = &e.old_path {
                if !out.contains(old) {
                    out.push(old.clone());
                }
            }
        }
    }
    Ok(out)
}

pub fn stage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let wd = workdir(repo)?;
    let mut index = repo.index()?;
    let lfs_on = crate::lfs::repo_uses_lfs(repo);
    for p in paths {
        let abs = wd.join(p);
        match std::fs::symlink_metadata(&abs) {
            Ok(m) if m.is_file() || m.file_type().is_symlink() => {
                if lfs_on && m.is_file() && crate::lfs::is_lfs_path(repo, p) {
                    crate::lfs::stage_lfs_file(repo, &mut index, p)?;
                } else {
                    index.add_path(Path::new(p))?;
                }
            }
            _ => {
                if index.get_path(Path::new(p), 0).is_some() || index.has_conflicts() {
                    let _ = index.remove_path(Path::new(p));
                }
            }
        }
    }
    index.write()?;
    Ok(())
}

pub fn unstage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    match repo.head() {
        Ok(h) => {
            let obj = h.peel(ObjectType::Commit)?;
            repo.reset_default(Some(&obj), paths.iter().map(|s| s.as_str()))?;
        }
        Err(_) => {
            // Unborn HEAD: unstaging means removing from the index entirely.
            let mut index = repo.index()?;
            for p in paths {
                if index.get_path(Path::new(p), 0).is_some() {
                    index.remove_path(Path::new(p))?;
                }
            }
            index.write()?;
        }
    }
    Ok(())
}

/// Discard working-tree changes: tracked files are restored from the index,
/// untracked files are deleted.
pub fn discard_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let wd = workdir(repo)?;
    let index = repo.index()?;
    let mut tracked = Vec::new();
    for p in paths {
        if index.get_path(Path::new(p), 0).is_some() {
            tracked.push(p.clone());
        } else {
            let abs = wd.join(p);
            if abs.is_dir() {
                std::fs::remove_dir_all(&abs)?;
            } else if abs.symlink_metadata().is_ok() {
                std::fs::remove_file(&abs)?;
            }
        }
    }
    if !tracked.is_empty() {
        let mut cb = CheckoutBuilder::new();
        cb.force();
        for p in &tracked {
            cb.path(p.as_str());
        }
        repo.checkout_index(None, Some(&mut cb))?;
        // Restoring an LFS file from the index writes its pointer; put the
        // real content back from the local LFS store when we have it.
        if crate::lfs::repo_uses_lfs(repo) {
            let _ = crate::lfs::smudge_paths_local(repo, &tracked);
        }
    }
    Ok(())
}
