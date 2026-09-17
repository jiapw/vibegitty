//! Git engine built on libgit2 (statically vendored). No external `git`
//! binary is required for any operation.

pub mod branch;
pub mod commit;
pub mod creds;
pub mod diff;
pub mod log;
pub mod merge;
pub mod rebase;
pub mod refs;
pub mod remote;
pub mod repo;
pub mod staging;
pub mod stash;
pub mod status;
pub mod tags;
pub mod types;

use crate::config::Settings;
use crate::error::{AppError, AppResult};
use git2::{Repository, RepositoryState, Signature};
use std::path::{Path, PathBuf};

pub fn open(path: &str) -> AppResult<Repository> {
    Repository::open(path)
        .map_err(|e| AppError::Msg(format!("Cannot open repository '{}': {}", path, e.message())))
}

pub fn workdir(repo: &Repository) -> AppResult<PathBuf> {
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::Msg("Bare repositories are not supported".into()))
}

/// Normalize a path to the platform's native separators without a trailing slash.
pub fn normalize_path(p: &Path) -> String {
    let pb: PathBuf = p.components().collect();
    pb.to_string_lossy().to_string()
}

pub fn short(oid: &git2::Oid) -> String {
    let s = oid.to_string();
    s[..7.min(s.len())].to_string()
}

pub fn make_signature(repo: &Repository, settings: &Settings) -> AppResult<Signature<'static>> {
    let name = settings.author_name.trim();
    let email = settings.author_email.trim();
    if !name.is_empty() && !email.is_empty() {
        return Ok(Signature::now(name, email)?);
    }
    repo.signature().map_err(|_| {
        AppError::Msg(
            "Author identity unknown. Set your name and email in Settings (or in git config user.name / user.email)."
                .into(),
        )
    })
}

pub fn state_name(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherrypick",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => "rebase",
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "mailbox",
    }
}

/// Turn libgit2 checkout conflicts into a friendlier message.
pub fn map_checkout_error(e: git2::Error) -> AppError {
    if e.code() == git2::ErrorCode::Conflict {
        AppError::Msg(format!(
            "Your local changes would be overwritten. Commit or stash them first. ({})",
            e.message()
        ))
    } else {
        e.into()
    }
}

/// Remote names (skipping any non-UTF-8 names).
pub fn remote_names(repo: &Repository) -> AppResult<Vec<String>> {
    Ok(repo
        .remotes()?
        .iter()
        .filter_map(|r| r.ok().flatten())
        .map(String::from)
        .collect())
}

/// Parents recorded in `.git/MERGE_HEAD` (empty when no merge is in progress).
pub fn merge_heads(repo: &Repository) -> Vec<git2::Oid> {
    std::fs::read_to_string(repo.path().join("MERGE_HEAD"))
        .map(|s| s.lines().filter_map(|l| git2::Oid::from_str(l.trim()).ok()).collect())
        .unwrap_or_default()
}

pub fn path_str(p: Option<&Path>) -> String {
    p.map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}
