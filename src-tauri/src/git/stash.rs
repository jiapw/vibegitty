use super::types::*;
use super::*;
use git2::{Repository, StashApplyOptions, StashFlags};

pub fn list(repo: &mut Repository) -> AppResult<Vec<StashInfo>> {
    let mut items = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        items.push(StashInfo {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
            time: 0,
        });
        true
    })?;
    for it in items.iter_mut() {
        if let Ok(c) = repo.find_commit(git2::Oid::from_str(&it.oid)?) {
            it.time = c.time().seconds();
        }
    }
    Ok(items)
}

pub fn save(repo: &mut Repository, settings: &Settings, message: Option<&str>, include_untracked: bool) -> AppResult<String> {
    let sig = make_signature(repo, settings)?;
    let mut flags = StashFlags::DEFAULT;
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    let msg = message.map(|m| m.trim()).filter(|m| !m.is_empty());
    let oid = repo.stash_save2(&sig, msg, Some(flags))?;
    branch::after_checkout(repo);
    Ok(oid.to_string())
}

pub fn apply(repo: &mut Repository, index: usize, pop: bool) -> AppResult<()> {
    let mut opts = StashApplyOptions::new();
    opts.reinstantiate_index();
    let r = if pop {
        repo.stash_pop(index, Some(&mut opts))
    } else {
        repo.stash_apply(index, Some(&mut opts))
    };
    r.map_err(|e| {
        if e.code() == git2::ErrorCode::Conflict || e.code() == git2::ErrorCode::MergeConflict {
            AppError::Msg(format!("Stash could not be applied cleanly: {}", e.message()))
        } else {
            e.into()
        }
    })?;
    branch::after_checkout(repo);
    Ok(())
}

pub fn drop(repo: &mut Repository, index: usize) -> AppResult<()> {
    repo.stash_drop(index)?;
    Ok(())
}
