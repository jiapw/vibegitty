use super::types::*;
use super::*;
use git2::{Config, ConfigLevel, Repository};

pub fn discover(path: &str) -> AppResult<Repository> {
    Repository::discover(path)
        .map_err(|e| AppError::Msg(format!("No git repository found at '{}': {}", path, e.message())))
}

pub fn info(repo: &Repository) -> AppResult<RepoInfo> {
    let wd = workdir(repo)?;
    let path = normalize_path(&wd);
    let name = wd
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(RepoInfo {
        path,
        name,
        head: refs::head_info(repo)?,
        state: state_name(repo.state()).to_string(),
        lfs_enabled: crate::lfs::repo_uses_lfs(repo),
    })
}

pub fn init(path: &str) -> AppResult<RepoInfo> {
    std::fs::create_dir_all(path)?;
    let repo = Repository::init(path)?;
    info(&repo)
}

pub fn remotes(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let mut out = Vec::new();
    for name in remote_names(repo)? {
        let r = repo.find_remote(&name)?;
        out.push(RemoteInfo {
            url: r.url().ok().map(String::from),
            push_url: r.pushurl().ok().flatten().map(String::from),
            name,
        });
    }
    Ok(out)
}

pub fn add_remote(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    repo.remote(name, url)?;
    Ok(())
}

pub fn remove_remote(repo: &Repository, name: &str) -> AppResult<()> {
    repo.remote_delete(name)?;
    Ok(())
}

/// Append patterns to the root `.gitignore` (skipping ones already present).
/// Returns the number of patterns added.
pub fn add_ignore_patterns(repo: &Repository, patterns: &[String]) -> AppResult<usize> {
    let p = workdir(repo)?.join(".gitignore");
    let mut out = std::fs::read_to_string(&p).unwrap_or_default();
    let existing: std::collections::HashSet<String> = out.lines().map(|l| l.trim().to_string()).collect();
    let mut added = 0;
    for pat in patterns {
        let pat = pat.trim();
        if pat.is_empty() || existing.contains(pat) {
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(pat);
        out.push('\n');
        added += 1;
    }
    if added > 0 {
        std::fs::write(&p, out)?;
    }
    Ok(added)
}

pub fn author(repo: &Repository, settings: &Settings) -> AppResult<AuthorInfo> {
    if !settings.author_name.trim().is_empty() && !settings.author_email.trim().is_empty() {
        return Ok(AuthorInfo {
            name: settings.author_name.clone(),
            email: settings.author_email.clone(),
            source: "settings".into(),
        });
    }
    let cfg = repo.config()?;
    let name = cfg.get_string("user.name").ok();
    let email = cfg.get_string("user.email").ok();
    let source = match cfg.get_entry("user.name") {
        Ok(e) => match e.level() {
            ConfigLevel::Local | ConfigLevel::Worktree => "repo",
            _ => "global",
        },
        Err(_) => "none",
    };
    Ok(AuthorInfo {
        name: name.unwrap_or_default(),
        email: email.unwrap_or_default(),
        source: source.into(),
    })
}

fn global_config() -> AppResult<Config> {
    let path = Config::find_global()
        .ok()
        .or_else(|| dirs::home_dir().map(|h| h.join(".gitconfig")))
        .ok_or_else(|| AppError::Msg("Cannot locate the global git config".into()))?;
    Ok(Config::open(&path)?)
}

pub fn set_author(repo: Option<&Repository>, name: &str, email: &str, global: bool) -> AppResult<()> {
    let mut cfg = match (repo, global) {
        (Some(r), false) => r.config()?,
        _ => global_config()?,
    };
    cfg.set_str("user.name", name)?;
    cfg.set_str("user.email", email)?;
    Ok(())
}
