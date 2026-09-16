use super::*;
use git2::{Commit, ErrorCode, Repository, RepositoryState};

pub fn commit(repo: &Repository, settings: &Settings, message: &str, amend: bool) -> AppResult<String> {
    let message = message.trim();
    if message.is_empty() {
        return crate::error::err("Commit message is empty");
    }
    let sig = make_signature(repo, settings)?;
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return crate::error::err("Resolve all conflicts before committing");
    }
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    if amend {
        let head = repo.head()?.peel_to_commit()?;
        let oid = head.amend(Some("HEAD"), None, Some(&sig), None, Some(message), Some(&tree))?;
        return Ok(oid.to_string());
    }

    let mut parents: Vec<Commit> = Vec::new();
    match repo.head() {
        Ok(h) => parents.push(h.peel_to_commit()?),
        Err(e) if e.code() == ErrorCode::UnbornBranch => {}
        Err(e) => return Err(e.into()),
    }
    let state = repo.state();
    if state == RepositoryState::Merge {
        for h in merge_heads(repo) {
            parents.push(repo.find_commit(h)?);
        }
    }
    if state == RepositoryState::Clean && parents.len() == 1 && parents[0].tree_id() == tree_oid {
        return crate::error::err("Nothing to commit: stage some changes first");
    }
    let parent_refs: Vec<&Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    if state != RepositoryState::Clean {
        repo.cleanup_state()?;
    }
    Ok(oid.to_string())
}
