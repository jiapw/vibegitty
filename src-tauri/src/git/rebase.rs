//! Rebase: replay the current branch's commits onto another ref, with the same
//! conflict handling as merges (stop on conflicts, resolve, then continue,
//! skip or abort). Uses libgit2's rebase machinery, so a stopped rebase looks
//! like one made by git and survives restarts.

use super::types::*;
use super::*;
use git2::build::CheckoutBuilder;
use git2::{AnnotatedCommit, BranchType, ErrorCode, ObjectType, Rebase, RebaseOptions, Repository, RepositoryState, ResetType};

pub fn is_rebasing(repo: &Repository) -> bool {
    matches!(
        repo.state(),
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge
    )
}

fn annotated_for<'r>(repo: &'r Repository, spec: &str) -> AppResult<AnnotatedCommit<'r>> {
    if let Ok(b) = repo.find_branch(spec, BranchType::Local) {
        return Ok(repo.reference_to_annotated_commit(b.get())?);
    }
    if let Ok(b) = repo.find_branch(spec, BranchType::Remote) {
        return Ok(repo.reference_to_annotated_commit(b.get())?);
    }
    if let Ok(r) = repo.find_reference(&format!("refs/tags/{spec}")) {
        return Ok(repo.reference_to_annotated_commit(&r)?);
    }
    let obj = repo.revparse_single(spec)?.peel(ObjectType::Commit)?;
    Ok(repo.find_annotated_commit(obj.id())?)
}

/// Rebase the current branch onto `onto` (local or remote branch, tag or commit).
pub fn rebase_onto(repo: &Repository, settings: &Settings, onto: &str) -> AppResult<MergeResult> {
    if repo.state() != RepositoryState::Clean {
        return crate::error::err("Finish or abort the current operation first");
    }
    let upstream = annotated_for(repo, onto)?;
    rebase_annotated(repo, settings, &upstream)
}

/// Rebase the current branch onto `upstream`; used by `rebase_onto` and by pull.
pub fn rebase_annotated(repo: &Repository, settings: &Settings, upstream: &AnnotatedCommit) -> AppResult<MergeResult> {
    let head_ref = repo.head()?;
    if !head_ref.is_branch() {
        return crate::error::err("Not on a branch (detached HEAD)");
    }
    let head_oid = head_ref
        .target()
        .ok_or_else(|| AppError::Msg("HEAD does not point at a commit".into()))?;
    let onto_oid = upstream.id();
    if onto_oid == head_oid || repo.graph_descendant_of(head_oid, onto_oid)? {
        // Everything from `onto` is already in our history: nothing to replay.
        return Ok(MergeResult {
            kind: "up_to_date".into(),
            oid: None,
            conflicts: vec![],
        });
    }
    if repo.graph_descendant_of(onto_oid, head_oid)? {
        // `onto` is strictly ahead of us: the rebase is a plain fast-forward.
        let obj = repo.find_object(onto_oid, None)?;
        let mut cb = CheckoutBuilder::new();
        cb.safe();
        repo.checkout_tree(&obj, Some(&mut cb)).map_err(map_checkout_error)?;
        let mut head = repo.head()?;
        head.set_target(onto_oid, "fast-forward (VibeGitty rebase)")?;
        branch::after_checkout(repo);
        return Ok(MergeResult {
            kind: "fast_forward".into(),
            oid: Some(onto_oid.to_string()),
            conflicts: vec![],
        });
    }
    let branch_ann = repo.reference_to_annotated_commit(&head_ref)?;
    let mut opts = RebaseOptions::new();
    let mut co = CheckoutBuilder::new();
    co.safe().allow_conflicts(true);
    opts.checkout_options(co);
    let mut rb = repo
        .rebase(Some(&branch_ann), Some(upstream), None, Some(&mut opts))
        .map_err(map_checkout_error)?;
    advance(repo, settings, &mut rb)
}

/// Replay the remaining steps; stops at the first conflict, finishes otherwise.
fn advance(repo: &Repository, settings: &Settings, rb: &mut Rebase<'_>) -> AppResult<MergeResult> {
    let sig = make_signature(repo, settings)?;
    while let Some(op) = rb.next() {
        op?;
        let mut index = repo.index()?;
        index.read(true)?;
        if index.has_conflicts() {
            return Ok(MergeResult {
                kind: "conflicts".into(),
                oid: None,
                conflicts: super::merge::conflict_paths(&index),
            });
        }
        match rb.commit(None, &sig, None) {
            Ok(_) => {}
            // The patch is already upstream: nothing to commit for this step.
            Err(e) if e.code() == ErrorCode::Applied => {}
            Err(e) => return Err(e.into()),
        }
    }
    rb.finish(None)?;
    branch::after_checkout(repo);
    let oid = repo.head()?.target().map(|o| o.to_string());
    Ok(MergeResult {
        kind: "rebased".into(),
        oid,
        conflicts: vec![],
    })
}

/// After the conflicts of the current step were resolved and staged: commit
/// that step and carry on.
pub fn rebase_continue(repo: &Repository, settings: &Settings) -> AppResult<MergeResult> {
    if !is_rebasing(repo) {
        return crate::error::err("No rebase in progress");
    }
    let mut index = repo.index()?;
    index.read(true)?;
    if index.has_conflicts() {
        return crate::error::err("Resolve all conflicts before continuing");
    }
    let sig = make_signature(repo, settings)?;
    let mut rb = repo.open_rebase(None)?;
    match rb.commit(None, &sig, None) {
        Ok(_) => {}
        Err(e) if e.code() == ErrorCode::Applied => {}
        Err(e) => return Err(e.into()),
    }
    advance(repo, settings, &mut rb)
}

/// Drop the commit being replayed and carry on with the next one.
pub fn rebase_skip(repo: &Repository, settings: &Settings) -> AppResult<MergeResult> {
    if !is_rebasing(repo) {
        return crate::error::err("No rebase in progress");
    }
    let mut rb = repo.open_rebase(None)?;
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), ResetType::Hard, None)?;
    advance(repo, settings, &mut rb)
}

/// Put the branch back where it was before the rebase started.
pub fn rebase_abort(repo: &Repository) -> AppResult<()> {
    let mut rb = repo.open_rebase(None)?;
    rb.abort()?;
    branch::after_checkout(repo);
    Ok(())
}

/// "step/total" of a rebase in progress, from libgit2's bookkeeping files.
pub fn rebase_progress(repo: &Repository) -> Option<String> {
    if !is_rebasing(repo) {
        return None;
    }
    let dir = repo.path().join("rebase-merge");
    let n = std::fs::read_to_string(dir.join("msgnum")).ok()?.trim().to_string();
    let m = std::fs::read_to_string(dir.join("end")).ok()?.trim().to_string();
    Some(format!("{n}/{m}"))
}
