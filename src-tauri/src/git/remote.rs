use super::creds::{callbacks, OpContext};
use super::types::*;
use super::*;
use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{AutotagOption, BranchType, FetchOptions, FetchPrune, PushOptions, Repository};
use std::path::Path;

/// Host (with optional port) of a remote URL. Supports `scheme://` URLs and
/// scp-like `user@host:path` syntax.
pub fn url_host(url: &str) -> Option<String> {
    if url.contains("://") {
        let u = url::Url::parse(url).ok()?;
        let h = u.host_str()?;
        return Some(match u.port() {
            Some(p) => format!("{h}:{p}"),
            None => h.to_string(),
        });
    }
    let (head, _) = url.split_once(':')?;
    if head.contains('/') || head.len() <= 1 {
        return None;
    }
    let host = head.rsplit('@').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

pub fn fetch(ctx: &OpContext, repo: &Repository, remote_name: Option<&str>, prune: bool) -> AppResult<Vec<String>> {
    let names: Vec<String> = match remote_name {
        Some(n) => vec![n.to_string()],
        None => remote_names(repo)?,
    };
    if names.is_empty() {
        return crate::error::err("This repository has no remotes");
    }
    for name in &names {
        let mut remote = repo.find_remote(name)?;
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(ctx));
        fo.download_tags(AutotagOption::Auto);
        if prune {
            fo.prune(FetchPrune::On);
        }
        ctx.progress("connecting", 0, 0, 0, Some(format!("Fetching {name}...")));
        remote.fetch(&[] as &[&str], Some(&mut fo), Some("fetch (VibeGitty)"))?;
    }
    Ok(names)
}

/// Resolve `(remote, upstream ref name)` for the current branch.
pub fn current_upstream(repo: &Repository) -> AppResult<(String, String, String)> {
    let head = repo.head()?;
    if !head.is_branch() {
        return crate::error::err("Not on a branch (detached HEAD)");
    }
    let branch_name = head.shorthand().unwrap_or("").to_string();
    let branch = repo.find_branch(&branch_name, BranchType::Local)?;
    let upstream = branch.upstream().map_err(|_| {
        AppError::Msg(format!(
            "Branch '{branch_name}' has no upstream. Push it first (with 'set upstream') or choose a remote branch to merge."
        ))
    })?;
    let upstream_name = upstream.name()?.unwrap_or("").to_string();
    let remote = repo
        .branch_upstream_remote(&format!("refs/heads/{branch_name}"))?
        .as_str()
        .unwrap_or("origin")
        .to_string();
    Ok((branch_name, remote, upstream_name))
}

pub fn pull(ctx: &OpContext, repo: &Repository, settings: &Settings, ff_only: bool) -> AppResult<PullResult> {
    let (_branch, remote, upstream_name) = current_upstream(repo)?;
    fetch(ctx, repo, Some(&remote), false)?;
    let upstream_ref = repo.find_reference(&format!("refs/remotes/{upstream_name}"))?;
    let annotated = repo.reference_to_annotated_commit(&upstream_ref)?;
    let msg = format!("Merge remote-tracking branch '{upstream_name}'");
    let merge = merge::merge_annotated(repo, settings, &annotated, &msg, ff_only)?;
    Ok(PullResult { remote, merge, lfs: None })
}

pub struct PushTarget {
    pub remote: String,
    pub branch: String,
    pub remote_branch: String,
}

pub fn resolve_push_target(repo: &Repository, remote_name: Option<&str>, branch: Option<&str>) -> AppResult<PushTarget> {
    let branch_name = match branch.filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            let head = repo.head()?;
            if !head.is_branch() {
                return crate::error::err("Not on a branch (detached HEAD)");
            }
            head.shorthand().unwrap_or("").to_string()
        }
    };
    let local = repo.find_branch(&branch_name, BranchType::Local)?;
    let (remote, remote_branch) = match remote_name.filter(|r| !r.is_empty()) {
        Some(r) => (r.to_string(), branch_name.clone()),
        None => match local.upstream() {
            Ok(up) => {
                let up_name = up.name()?.unwrap_or("").to_string();
                let remote = repo
                    .branch_upstream_remote(&format!("refs/heads/{branch_name}"))?
                    .as_str()
                    .unwrap_or("origin")
                    .to_string();
                let rb = up_name
                    .strip_prefix(&format!("{remote}/"))
                    .unwrap_or(&up_name)
                    .to_string();
                (remote, rb)
            }
            Err(_) => {
                let remotes = remote_names(repo)?;
                let remote = if remotes.iter().any(|r| r == "origin") {
                    "origin".to_string()
                } else {
                    remotes.first().cloned().unwrap_or_else(|| "origin".to_string())
                };
                (remote, branch_name.clone())
            }
        },
    };
    Ok(PushTarget {
        remote,
        branch: branch_name,
        remote_branch,
    })
}

pub fn push(ctx: &OpContext, repo: &Repository, target: &PushTarget, force: bool, set_upstream: bool) -> AppResult<()> {
    let refspec = format!(
        "{}refs/heads/{}:refs/heads/{}",
        if force { "+" } else { "" },
        target.branch,
        target.remote_branch
    );
    ctx.progress("connecting", 0, 0, 0, Some(format!("Pushing to {}...", target.remote)));
    let do_push = |repo: &Repository| -> Result<(), git2::Error> {
        let mut remote = repo.find_remote(&target.remote)?;
        let mut po = PushOptions::new();
        po.remote_callbacks(callbacks(ctx));
        remote.push(&[refspec.as_str()], Some(&mut po))
    };
    let mut result = do_push(repo);
    if let Err(e) = &result {
        // libgit2 needs the remote's current tip locally to compute the pack;
        // fetch and retry once (this also gives a precise non-fast-forward error).
        if e.message().contains("not present locally") {
            fetch(ctx, repo, Some(&target.remote), false)?;
            result = do_push(repo);
        }
    }
    result.map_err(|e| {
        let m = e.message();
        let ml = m.to_lowercase();
        if ml.contains("fast-forward") || ml.contains("fastforward") || ml.contains("fetch first") || ml.contains("rejected") {
            AppError::Msg(format!(
                "Push rejected: the remote branch has commits you don't have. Pull first, or force push. ({m})"
            ))
        } else {
            AppError::Git(e)
        }
    })?;
    let mut local = repo.find_branch(&target.branch, BranchType::Local)?;
    if set_upstream || local.upstream().is_err() {
        let _ = local.set_upstream(Some(&format!("{}/{}", target.remote, target.remote_branch)));
    }
    Ok(())
}

pub fn push_refspec(ctx: &OpContext, repo: &Repository, remote_name: &str, refspec: &str) -> AppResult<()> {
    let mut remote = repo.find_remote(remote_name)?;
    let mut po = PushOptions::new();
    po.remote_callbacks(callbacks(ctx));
    remote.push(&[refspec], Some(&mut po))?;
    Ok(())
}

pub fn delete_remote_branch(ctx: &OpContext, repo: &Repository, remote_name: &str, branch: &str) -> AppResult<()> {
    push_refspec(ctx, repo, remote_name, &format!(":refs/heads/{branch}"))?;
    if let Ok(mut b) = repo.find_branch(&format!("{remote_name}/{branch}"), BranchType::Remote) {
        let _ = b.delete();
    }
    Ok(())
}

pub fn push_tag(ctx: &OpContext, repo: &Repository, remote_name: &str, tag: &str) -> AppResult<()> {
    push_refspec(ctx, repo, remote_name, &format!("refs/tags/{tag}:refs/tags/{tag}"))
}

pub fn clone(ctx: &OpContext, url: &str, dest: &Path) -> AppResult<Repository> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(ctx));
    let c = ctx.clone();
    let mut co = CheckoutBuilder::new();
    co.progress(move |_path, cur, total| {
        if cur == total || cur % 50 == 0 {
            c.progress("checkout", cur as u64, total as u64, 0, None);
        }
    });
    ctx.progress("connecting", 0, 0, 0, Some(format!("Cloning {url}...")));
    let repo = RepoBuilder::new().fetch_options(fo).with_checkout(co).clone(url, dest)?;
    Ok(repo)
}
