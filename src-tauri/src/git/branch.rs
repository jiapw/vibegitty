use super::*;
use git2::build::CheckoutBuilder;
use git2::{BranchType, ObjectType, Repository};

pub fn create_branch(repo: &Repository, name: &str, target: Option<&str>, checkout: bool) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return crate::error::err("Branch name is empty");
    }
    if !git2::Branch::name_is_valid(name)? {
        return crate::error::err(format!("'{name}' is not a valid branch name"));
    }
    let commit = match target {
        Some(t) if !t.is_empty() => repo.revparse_single(t)?.peel_to_commit()?,
        _ => repo.head()?.peel_to_commit()?,
    };
    repo.branch(name, &commit, false)?;
    if checkout {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let refname = format!("refs/heads/{name}");
    let obj = repo.revparse_single(&refname)?;
    let mut cb = CheckoutBuilder::new();
    cb.safe();
    repo.checkout_tree(&obj, Some(&mut cb)).map_err(map_checkout_error)?;
    repo.set_head(&refname)?;
    after_checkout(repo);
    Ok(())
}

/// Create a local tracking branch from `origin/feature` (if needed) and check it out.
pub fn checkout_remote_branch(repo: &Repository, remote_branch: &str, local_name: Option<&str>) -> AppResult<String> {
    let default_local = remote_branch.split_once('/').map(|(_, b)| b).unwrap_or(remote_branch);
    let local = local_name.filter(|s| !s.trim().is_empty()).unwrap_or(default_local).to_string();
    if repo.find_branch(&local, BranchType::Local).is_err() {
        let rb = repo.find_branch(remote_branch, BranchType::Remote)?;
        let commit = rb.get().peel_to_commit()?;
        let mut b = repo.branch(&local, &commit, false)?;
        b.set_upstream(Some(remote_branch))?;
    }
    checkout_branch(repo, &local)?;
    Ok(local)
}

pub fn checkout_commit(repo: &Repository, spec: &str) -> AppResult<()> {
    let obj = repo.revparse_single(spec)?.peel(ObjectType::Commit)?;
    let mut cb = CheckoutBuilder::new();
    cb.safe();
    repo.checkout_tree(&obj, Some(&mut cb)).map_err(map_checkout_error)?;
    repo.set_head_detached(obj.id())?;
    after_checkout(repo);
    Ok(())
}

pub fn delete_branch(repo: &Repository, name: &str, force: bool) -> AppResult<()> {
    let mut b = repo.find_branch(name, BranchType::Local)?;
    if b.is_head() {
        return crate::error::err("Cannot delete the checked-out branch");
    }
    if !force {
        let tip = b.get().target().ok_or("branch has no target")?;
        let merged_into_head = match repo.head().ok().and_then(|h| h.target()) {
            Some(head) => repo.graph_descendant_of(head, tip).unwrap_or(false) || head == tip,
            None => false,
        };
        let merged_into_upstream = b
            .upstream()
            .ok()
            .and_then(|u| u.get().target())
            .map(|u| u == tip || repo.graph_descendant_of(u, tip).unwrap_or(false))
            .unwrap_or(false);
        if !merged_into_head && !merged_into_upstream {
            return crate::error::err(format!(
                "Branch '{name}' is not fully merged. Use force delete to discard its commits."
            ));
        }
    }
    b.delete()?;
    Ok(())
}

pub fn rename_branch(repo: &Repository, old: &str, new: &str) -> AppResult<()> {
    let mut b = repo.find_branch(old, BranchType::Local)?;
    b.rename(new.trim(), false)?;
    Ok(())
}

pub fn set_upstream(repo: &Repository, branch: &str, upstream: Option<&str>) -> AppResult<()> {
    let mut b = repo.find_branch(branch, BranchType::Local)?;
    b.set_upstream(upstream.filter(|s| !s.is_empty()))?;
    Ok(())
}

/// Post-checkout hook: restore LFS content that is available locally.
pub fn after_checkout(repo: &Repository) {
    if crate::lfs::repo_uses_lfs(repo) {
        if let Err(e) = crate::lfs::smudge_all_local(repo) {
            ::log::warn!("lfs smudge after checkout failed: {e}");
        }
    }
}
