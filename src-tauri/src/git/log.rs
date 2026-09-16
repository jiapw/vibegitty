use super::types::*;
use super::*;
use git2::{Commit, Repository, Sort};

pub fn commit_info(c: &Commit) -> CommitInfo {
    let author = c.author();
    let committer = c.committer();
    CommitInfo {
        oid: c.id().to_string(),
        short_oid: short(&c.id()),
        parents: c.parent_ids().map(|p| p.to_string()).collect(),
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        committer_name: committer.name().unwrap_or("").to_string(),
        committer_email: committer.email().unwrap_or("").to_string(),
        time: committer.when().seconds(),
        author_time: author.when().seconds(),
        summary: c.summary().ok().flatten().unwrap_or("").to_string(),
        body: c.body().ok().flatten().unwrap_or("").trim().to_string(),
    }
}

/// Commit history over all branches, remotes and tags (like `git log --all`),
/// topologically sorted with time as tie breaker.
pub fn get_log(repo: &Repository, skip: usize, limit: usize) -> AppResult<LogPage> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
        walk.push_glob(glob)?;
    }
    if repo.head().is_ok() {
        walk.push_head()?;
    }
    let mut commits = Vec::with_capacity(limit.min(2000));
    let mut has_more = false;
    for oid in walk.skip(skip) {
        let oid = oid?;
        if commits.len() >= limit {
            has_more = true;
            break;
        }
        let c = repo.find_commit(oid)?;
        commits.push(commit_info(&c));
    }
    Ok(LogPage { commits, has_more })
}

