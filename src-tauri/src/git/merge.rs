use super::types::*;
use super::*;
use git2::build::CheckoutBuilder;
use git2::{AnnotatedCommit, BranchType, Index, MergeOptions, ObjectType, Oid, Repository, ResetType};
use std::path::Path;

pub fn conflict_paths(index: &Index) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(conflicts) = index.conflicts() {
        for c in conflicts.flatten() {
            if let Some(e) = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref()) {
                out.push(String::from_utf8_lossy(&e.path).to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn merge_annotated(
    repo: &Repository,
    settings: &Settings,
    their: &AnnotatedCommit,
    message: &str,
    ff_only: bool,
) -> AppResult<MergeResult> {
    let (analysis, pref) = repo.merge_analysis(&[their])?;

    if analysis.is_up_to_date() {
        return Ok(MergeResult {
            kind: "up_to_date".into(),
            oid: None,
            conflicts: vec![],
        });
    }

    if analysis.is_unborn() {
        let refname = repo
            .find_reference("HEAD")?
            .symbolic_target()
            .ok()
            .flatten()
            .unwrap_or("refs/heads/main")
            .to_string();
        repo.reference(&refname, their.id(), true, "initial checkout")?;
        repo.set_head(&refname)?;
        let mut cb = CheckoutBuilder::new();
        cb.force();
        repo.checkout_head(Some(&mut cb))?;
        branch::after_checkout(repo);
        return Ok(MergeResult {
            kind: "fast_forward".into(),
            oid: Some(their.id().to_string()),
            conflicts: vec![],
        });
    }

    if analysis.is_fast_forward() && !pref.is_no_fast_forward() {
        let obj = repo.find_object(their.id(), None)?;
        let mut cb = CheckoutBuilder::new();
        cb.safe();
        repo.checkout_tree(&obj, Some(&mut cb)).map_err(map_checkout_error)?;
        let mut head = repo.head()?;
        head.set_target(their.id(), "fast-forward (VibeGitty)")?;
        branch::after_checkout(repo);
        return Ok(MergeResult {
            kind: "fast_forward".into(),
            oid: Some(their.id().to_string()),
            conflicts: vec![],
        });
    }

    if ff_only {
        return crate::error::err("Cannot fast-forward: the branches have diverged. Pull with merge instead.");
    }

    if analysis.is_normal() {
        let mut mo = MergeOptions::new();
        let mut co = CheckoutBuilder::new();
        co.safe().allow_conflicts(true);
        repo.merge(&[their], Some(&mut mo), Some(&mut co)).map_err(map_checkout_error)?;
        let mut index = repo.index()?;
        if index.has_conflicts() {
            return Ok(MergeResult {
                kind: "conflicts".into(),
                oid: None,
                conflicts: conflict_paths(&index),
            });
        }
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let head_commit = repo.head()?.peel_to_commit()?;
        let their_commit = repo.find_commit(their.id())?;
        let sig = make_signature(repo, settings)?;
        let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&head_commit, &their_commit])?;
        repo.cleanup_state()?;
        branch::after_checkout(repo);
        return Ok(MergeResult {
            kind: "merged".into(),
            oid: Some(oid.to_string()),
            conflicts: vec![],
        });
    }

    crate::error::err("Merge is not possible for these branches")
}

/// Merge a local branch, remote branch, tag or commit into the current branch.
pub fn merge_branch(repo: &Repository, settings: &Settings, source: &str, ff_only: bool) -> AppResult<MergeResult> {
    if repo.state() != git2::RepositoryState::Clean {
        return crate::error::err("Finish or abort the current merge first");
    }
    let (annotated, message) = if let Ok(b) = repo.find_branch(source, BranchType::Local) {
        (
            repo.reference_to_annotated_commit(b.get())?,
            format!("Merge branch '{source}'"),
        )
    } else if let Ok(b) = repo.find_branch(source, BranchType::Remote) {
        (
            repo.reference_to_annotated_commit(b.get())?,
            format!("Merge remote-tracking branch '{source}'"),
        )
    } else if let Ok(r) = repo.find_reference(&format!("refs/tags/{source}")) {
        (
            repo.reference_to_annotated_commit(&r)?,
            format!("Merge tag '{source}'"),
        )
    } else {
        let obj = repo.revparse_single(source)?.peel(ObjectType::Commit)?;
        (
            repo.find_annotated_commit(obj.id())?,
            format!("Merge commit '{}'", short(&obj.id())),
        )
    };
    merge_annotated(repo, settings, &annotated, &message, ff_only)
}

/// Abort an in-progress merge / cherry-pick / revert (like `git merge --abort`).
pub fn abort_operation(repo: &Repository) -> AppResult<()> {
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), ResetType::Hard, None)?;
    repo.cleanup_state()?;
    branch::after_checkout(repo);
    Ok(())
}

/// Resolve a conflicted path by taking one side entirely.
pub fn resolve_conflict(repo: &Repository, path: &str, side: &str) -> AppResult<()> {
    let wd = workdir(repo)?;
    let mut index = repo.index()?;
    let mut chosen: Option<Option<git2::IndexEntry>> = None;
    for c in index.conflicts()?.flatten() {
        let p = c
            .our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string());
        if p.as_deref() == Some(path) {
            chosen = Some(match side {
                "theirs" => c.their,
                _ => c.our,
            });
            break;
        }
    }
    let Some(entry) = chosen else {
        return crate::error::err(format!("'{path}' is not in conflict"));
    };
    let abs = wd.join(path);
    match entry {
        Some(e) => {
            let blob = repo.find_blob(e.id)?;
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&abs, blob.content())?;
            index.add_path(Path::new(path))?;
        }
        None => {
            if abs.exists() {
                std::fs::remove_file(&abs)?;
            }
            index.remove_path(Path::new(path))?;
        }
    }
    index.write()?;
    Ok(())
}

pub fn cherry_pick(repo: &Repository, settings: &Settings, oid: &str) -> AppResult<MergeResult> {
    let commit = repo.find_commit(Oid::from_str(oid)?)?;
    let mut opts = git2::CherrypickOptions::new();
    let mut co = CheckoutBuilder::new();
    co.safe().allow_conflicts(true);
    opts.checkout_builder(co);
    repo.cherrypick(&commit, Some(&mut opts)).map_err(map_checkout_error)?;
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(MergeResult {
            kind: "conflicts".into(),
            oid: None,
            conflicts: conflict_paths(&index),
        });
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    let head = repo.head()?.peel_to_commit()?;
    let sig = make_signature(repo, settings)?;
    let author = commit.author();
    let new_oid = repo.commit(
        Some("HEAD"),
        &author,
        &sig,
        commit.message().unwrap_or("cherry-pick"),
        &tree,
        &[&head],
    )?;
    repo.cleanup_state()?;
    Ok(MergeResult {
        kind: "merged".into(),
        oid: Some(new_oid.to_string()),
        conflicts: vec![],
    })
}

pub fn revert(repo: &Repository, settings: &Settings, oid: &str) -> AppResult<MergeResult> {
    let commit = repo.find_commit(Oid::from_str(oid)?)?;
    let mut opts = git2::RevertOptions::new();
    let mut co = CheckoutBuilder::new();
    co.safe().allow_conflicts(true);
    opts.checkout_builder(co);
    repo.revert(&commit, Some(&mut opts)).map_err(map_checkout_error)?;
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(MergeResult {
            kind: "conflicts".into(),
            oid: None,
            conflicts: conflict_paths(&index),
        });
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    let head = repo.head()?.peel_to_commit()?;
    let sig = make_signature(repo, settings)?;
    let msg = format!(
        "Revert \"{}\"\n\nThis reverts commit {}.",
        commit.summary().ok().flatten().unwrap_or(""),
        commit.id()
    );
    let new_oid = repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &[&head])?;
    repo.cleanup_state()?;
    Ok(MergeResult {
        kind: "merged".into(),
        oid: Some(new_oid.to_string()),
        conflicts: vec![],
    })
}

pub fn reset(repo: &Repository, spec: &str, mode: &str) -> AppResult<()> {
    let obj = repo.revparse_single(spec)?.peel(ObjectType::Commit)?;
    let kind = match mode {
        "soft" => ResetType::Soft,
        "hard" => ResetType::Hard,
        _ => ResetType::Mixed,
    };
    repo.reset(&obj, kind, None)?;
    if kind == ResetType::Hard {
        branch::after_checkout(repo);
    }
    Ok(())
}
