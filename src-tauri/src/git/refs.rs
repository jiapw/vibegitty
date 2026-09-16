use super::types::*;
use super::*;
use git2::{BranchType, ErrorCode, ObjectType, Repository};

pub fn head_info(repo: &Repository) -> AppResult<HeadInfo> {
    match repo.head() {
        Ok(h) => {
            let oid = h.target().map(|o| o.to_string());
            if h.is_branch() {
                let name = h.shorthand().unwrap_or("").to_string();
                let (upstream, ahead, behind) = upstream_of(repo, &name);
                Ok(HeadInfo {
                    branch: Some(name),
                    oid,
                    detached: false,
                    unborn: false,
                    upstream,
                    ahead,
                    behind,
                })
            } else {
                Ok(HeadInfo {
                    branch: None,
                    oid,
                    detached: true,
                    unborn: false,
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                })
            }
        }
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().ok().flatten().map(|s| s.trim_start_matches("refs/heads/").to_string()));
            Ok(HeadInfo {
                branch: name,
                oid: None,
                detached: false,
                unborn: true,
                upstream: None,
                ahead: 0,
                behind: 0,
            })
        }
        Err(e) => Err(e.into()),
    }
}

/// Upstream name and ahead/behind counts for a local branch.
pub fn upstream_of(repo: &Repository, branch: &str) -> (Option<String>, usize, usize) {
    let Ok(b) = repo.find_branch(branch, BranchType::Local) else {
        return (None, 0, 0);
    };
    let Ok(up) = b.upstream() else {
        return (None, 0, 0);
    };
    let name = up.name().ok().flatten().map(String::from);
    let (ahead, behind) = match (b.get().target(), up.get().target()) {
        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
        _ => (0, 0),
    };
    (name, ahead, behind)
}

pub fn list_refs(repo: &Repository) -> AppResult<Vec<RefInfo>> {
    let mut out = Vec::new();

    for item in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = item?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        let Some(oid) = branch.get().target() else { continue };
        let (upstream, ahead, behind) = upstream_of(repo, &name);
        out.push(RefInfo {
            full_name: format!("refs/heads/{name}"),
            name,
            kind: "local".into(),
            oid: oid.to_string(),
            is_head: branch.is_head(),
            upstream,
            ahead,
            behind,
            remote: None,
            message: None,
        });
    }

    for item in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = item?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        let Some(oid) = branch.get().target() else { continue };
        let remote = name.split('/').next().map(String::from);
        out.push(RefInfo {
            full_name: format!("refs/remotes/{name}"),
            name,
            kind: "remote".into(),
            oid: oid.to_string(),
            is_head: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            remote,
            message: None,
        });
    }

    let mut tags: Vec<(String, String, git2::Oid, Option<String>)> = Vec::new();
    repo.tag_foreach(|oid, name| {
        let full = String::from_utf8_lossy(name).to_string();
        let short = full.trim_start_matches("refs/tags/").to_string();
        let (target, message) = match repo.find_tag(oid) {
            Ok(t) => (t.target_id(), t.message().ok().flatten().map(|m| m.trim().to_string())),
            Err(_) => (oid, None),
        };
        tags.push((short, full, target, message));
        true
    })?;
    for (short, full, target, message) in tags {
        let commit_oid = repo
            .find_object(target, None)
            .ok()
            .and_then(|o| o.peel(ObjectType::Commit).ok())
            .map(|c| c.id())
            .unwrap_or(target);
        out.push(RefInfo {
            name: short,
            full_name: full,
            kind: "tag".into(),
            oid: commit_oid.to_string(),
            is_head: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            remote: None,
            message,
        });
    }

    Ok(out)
}
