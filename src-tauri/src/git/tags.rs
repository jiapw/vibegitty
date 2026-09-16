use super::*;
use git2::Repository;

pub fn create(repo: &Repository, settings: &Settings, name: &str, target: Option<&str>, message: Option<&str>) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return crate::error::err("Tag name is empty");
    }
    let spec = target.filter(|t| !t.is_empty()).unwrap_or("HEAD");
    let obj = repo.revparse_single(spec)?;
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(msg) => {
            let sig = make_signature(repo, settings)?;
            repo.tag(name, &obj, &sig, msg, false)?;
        }
        None => {
            repo.tag_lightweight(name, &obj, false)?;
        }
    }
    Ok(())
}

pub fn delete(repo: &Repository, name: &str) -> AppResult<()> {
    repo.tag_delete(name)?;
    Ok(())
}
