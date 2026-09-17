//! Tauri command layer: thin async wrappers around the git / lfs / auth modules.

use crate::config::{self, Account, AppConfig, Provider, Settings};
use serde::Serialize;
use crate::error::{blocking, AppResult};
use crate::git::creds::OpContext;
use crate::git::types::*;
use crate::git::{self, workdir};
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, State};

fn ctx(app: &AppHandle, state: &AppState, repo: &str, op: &str) -> OpContext {
    OpContext::new(app.clone(), repo, op, state.credentials())
}

fn register_repo(app: &AppHandle, state: &AppState, path: &str) {
    let p = path.to_string();
    state.update(|c| {
        if !c.open_repos.contains(&p) {
            c.open_repos.push(p.clone());
        }
        c.recent_repos.retain(|r| r != &p);
        c.recent_repos.insert(0, p.clone());
        c.recent_repos.truncate(20);
        c.active_repo = Some(p.clone());
    });
    let mut watchers = state.watchers.lock();
    if !watchers.contains_key(path) {
        match crate::watcher::watch(app.clone(), path.to_string()) {
            Ok(h) => {
                watchers.insert(path.to_string(), h);
            }
            Err(e) => log::warn!("watcher for {path} not started: {e}"),
        }
    }
}

// ----- config -------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub portable: bool,
    pub builtin_github_client_id: bool,
    /// A client secret is compiled in, so github.com sign-in completes in the browser.
    pub github_browser_login: bool,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        portable: config::is_portable(),
        builtin_github_client_id: config::builtin_github_client_id().is_some(),
        github_browser_login: config::builtin_github_client_id().is_some() && config::builtin_github_client_secret().is_some(),
    }
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    state.update(|c| c.settings = settings);
    Ok(())
}

#[tauri::command]
pub fn remove_recent_repo(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.update(|c| c.recent_repos.retain(|r| r != &path));
    Ok(())
}

#[tauri::command]
pub fn save_ui_prefs(state: State<'_, AppState>, prefs: serde_json::Map<String, serde_json::Value>) -> AppResult<()> {
    state.update(|c| {
        for (k, v) in prefs {
            c.ui.insert(k, v);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn set_active_repo(state: State<'_, AppState>, path: Option<String>) -> AppResult<()> {
    state.update(|c| c.active_repo = path);
    Ok(())
}

#[tauri::command]
pub fn close_repo(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.update(|c| {
        c.open_repos.retain(|p| p != &path);
        if c.active_repo.as_deref() == Some(path.as_str()) {
            c.active_repo = c.open_repos.first().cloned();
        }
    });
    state.watchers.lock().remove(&path);
    Ok(())
}

// ----- repositories -------------------------------------------------------

#[tauri::command]
pub async fn open_repo(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<RepoInfo> {
    let info = blocking(move || {
        let repo = git::repo::discover(&path)?;
        // Restore LFS content that is already in the local store.
        if crate::lfs::repo_uses_lfs(&repo) {
            if let Err(e) = crate::lfs::smudge_all_local(&repo) {
                log::warn!("lfs smudge on open failed: {e}");
            }
        }
        git::repo::info(&repo)
    })
    .await?;
    register_repo(&app, &state, &info.path);
    Ok(info)
}

#[tauri::command]
pub async fn init_repo(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<RepoInfo> {
    let info = blocking(move || git::repo::init(&path)).await?;
    register_repo(&app, &state, &info.path);
    Ok(info)
}

#[tauri::command]
pub async fn clone_repo(app: AppHandle, state: State<'_, AppState>, url: String, dest: String) -> AppResult<RepoInfo> {
    let c = ctx(&app, &state, &dest, "clone");
    let c2 = c.clone();
    let dest2 = dest.clone();
    let result = blocking(move || {
        let repo = git::remote::clone(&c2, &url, Path::new(&dest2))?;
        git::repo::info(&repo)
    })
    .await;
    c.done(None);
    let info = result?;
    if info.lfs_enabled {
        let c = ctx(&app, &state, &info.path, "lfs-download");
        match crate::lfs::fetch_and_smudge(app.clone(), &state, info.path.clone(), None).await {
            Ok(r) => log::info!("lfs after clone: {r:?}"),
            Err(e) => log::warn!("lfs after clone failed: {e}"),
        }
        c.done(None);
    }
    register_repo(&app, &state, &info.path);
    Ok(info)
}

#[tauri::command]
pub async fn get_repo_info(repo_path: String) -> AppResult<RepoInfo> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        // Pointer files whose objects are already in the local LFS store are
        // restored transparently (like git-lfs' smudge filter would).
        if crate::lfs::repo_uses_lfs(&repo) {
            if let Err(e) = crate::lfs::smudge_all_local(&repo) {
                log::warn!("lfs smudge failed: {e}");
            }
        }
        git::repo::info(&repo)
    })
    .await
}

#[tauri::command]
pub async fn get_refs(repo_path: String) -> AppResult<Vec<RefInfo>> {
    blocking(move || git::refs::list_refs(&git::open(&repo_path)?)).await
}

#[tauri::command]
pub async fn get_log(repo_path: String, skip: usize, limit: usize) -> AppResult<LogPage> {
    blocking(move || git::log::get_log(&git::open(&repo_path)?, skip, limit.clamp(1, 5000))).await
}

#[tauri::command]
pub async fn get_status(repo_path: String) -> AppResult<WorkingStatus> {
    blocking(move || git::status::working_status(&git::open(&repo_path)?)).await
}

#[tauri::command]
pub async fn get_remotes(repo_path: String) -> AppResult<Vec<RemoteInfo>> {
    blocking(move || git::repo::remotes(&git::open(&repo_path)?)).await
}

#[tauri::command]
pub async fn add_remote(repo_path: String, name: String, url: String) -> AppResult<()> {
    blocking(move || git::repo::add_remote(&git::open(&repo_path)?, name.trim(), url.trim())).await
}

#[tauri::command]
pub async fn remove_remote(repo_path: String, name: String) -> AppResult<()> {
    blocking(move || git::repo::remove_remote(&git::open(&repo_path)?, &name)).await
}

#[tauri::command]
pub async fn add_gitignore_patterns(repo_path: String, patterns: Vec<String>) -> AppResult<usize> {
    blocking(move || git::repo::add_ignore_patterns(&git::open(&repo_path)?, &patterns)).await
}

#[tauri::command]
pub async fn get_stashes(repo_path: String) -> AppResult<Vec<StashInfo>> {
    blocking(move || git::stash::list(&mut git::open(&repo_path)?)).await
}

#[tauri::command]
pub async fn get_commit_detail(repo_path: String, oid: String) -> AppResult<CommitDetail> {
    blocking(move || git::diff::commit_detail(&git::open(&repo_path)?, &oid)).await
}

#[tauri::command]
pub async fn get_diff(repo_path: String, target: DiffTarget) -> AppResult<FileDiff> {
    blocking(move || git::diff::get_diff(&git::open(&repo_path)?, &target)).await
}

// ----- staging & commit ---------------------------------------------------

#[tauri::command]
pub async fn stage_paths(repo_path: String, paths: Vec<String>) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let paths = git::staging::expand_renames(&repo, &paths, false)?;
        git::staging::stage_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn unstage_paths(repo_path: String, paths: Vec<String>) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let paths = git::staging::expand_renames(&repo, &paths, true)?;
        git::staging::unstage_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn stage_all(repo_path: String) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let st = git::status::working_status(&repo)?;
        let mut paths: Vec<String> = Vec::new();
        for e in st.unstaged {
            paths.push(e.path);
            if let Some(old) = e.old_path {
                paths.push(old);
            }
        }
        if paths.is_empty() {
            return Ok(());
        }
        git::staging::stage_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn unstage_all(repo_path: String) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let st = git::status::working_status(&repo)?;
        let mut paths: Vec<String> = Vec::new();
        for e in st.staged {
            paths.push(e.path);
            if let Some(old) = e.old_path {
                paths.push(old);
            }
        }
        if paths.is_empty() {
            return Ok(());
        }
        git::staging::unstage_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn discard_paths(repo_path: String, paths: Vec<String>) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let paths = git::staging::expand_renames(&repo, &paths, false)?;
        git::staging::discard_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn discard_all(repo_path: String) -> AppResult<()> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        let st = git::status::working_status(&repo)?;
        let mut paths: Vec<String> = Vec::new();
        for e in st.unstaged {
            paths.push(e.path);
            if let Some(old) = e.old_path {
                paths.push(old);
            }
        }
        if paths.is_empty() {
            return Ok(());
        }
        git::staging::discard_paths(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn commit(state: State<'_, AppState>, repo_path: String, message: String, amend: bool) -> AppResult<String> {
    let settings = state.settings();
    blocking(move || git::commit::commit(&git::open(&repo_path)?, &settings, &message, amend)).await
}

// ----- branches -----------------------------------------------------------

#[tauri::command]
pub async fn create_branch(repo_path: String, name: String, target: Option<String>, checkout: bool) -> AppResult<()> {
    blocking(move || git::branch::create_branch(&git::open(&repo_path)?, &name, target.as_deref(), checkout)).await
}

#[tauri::command]
pub async fn checkout_branch(repo_path: String, name: String) -> AppResult<()> {
    blocking(move || git::branch::checkout_branch(&git::open(&repo_path)?, &name)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(repo_path: String, remote_branch: String, local_name: Option<String>) -> AppResult<String> {
    blocking(move || git::branch::checkout_remote_branch(&git::open(&repo_path)?, &remote_branch, local_name.as_deref())).await
}

#[tauri::command]
pub async fn checkout_commit(repo_path: String, oid: String) -> AppResult<()> {
    blocking(move || git::branch::checkout_commit(&git::open(&repo_path)?, &oid)).await
}

#[tauri::command]
pub async fn delete_branch(repo_path: String, name: String, force: bool) -> AppResult<()> {
    blocking(move || git::branch::delete_branch(&git::open(&repo_path)?, &name, force)).await
}

#[tauri::command]
pub async fn rename_branch(repo_path: String, old_name: String, new_name: String) -> AppResult<()> {
    blocking(move || git::branch::rename_branch(&git::open(&repo_path)?, &old_name, &new_name)).await
}

#[tauri::command]
pub async fn set_upstream(repo_path: String, branch: String, upstream: Option<String>) -> AppResult<()> {
    blocking(move || git::branch::set_upstream(&git::open(&repo_path)?, &branch, upstream.as_deref())).await
}

// ----- remote operations --------------------------------------------------

#[tauri::command]
pub async fn fetch(app: AppHandle, state: State<'_, AppState>, repo_path: String, remote: Option<String>, prune: bool) -> AppResult<Vec<String>> {
    let c = ctx(&app, &state, &repo_path, "fetch");
    let c2 = c.clone();
    let r = blocking(move || git::remote::fetch(&c2, &git::open(&repo_path)?, remote.as_deref(), prune)).await;
    c.done(None);
    r
}

#[tauri::command]
pub async fn pull(app: AppHandle, state: State<'_, AppState>, repo_path: String, mode: String) -> AppResult<PullResult> {
    let c = ctx(&app, &state, &repo_path, "pull");
    let c2 = c.clone();
    let settings = state.settings();
    let rp = repo_path.clone();
    let r = blocking(move || {
        let repo = git::open(&rp)?;
        let res = git::remote::pull(&c2, &repo, &settings, &mode)?;
        Ok((res, crate::lfs::repo_uses_lfs(&repo)))
    })
    .await;
    c.done(None);
    let (mut res, lfs) = r?;
    if lfs && res.merge.kind != "up_to_date" {
        let c = ctx(&app, &state, &repo_path, "lfs-download");
        let remote = res.remote.clone();
        match crate::lfs::fetch_and_smudge(app.clone(), &state, repo_path, Some(remote)).await {
            Ok(rep) => res.lfs = Some(rep),
            Err(e) => log::warn!("lfs after pull failed: {e}"),
        }
        c.done(None);
    }
    Ok(res)
}

#[tauri::command]
pub async fn push(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
) -> AppResult<PushResult> {
    let rp = repo_path.clone();
    let (target_remote, target_branch, target_remote_branch) = blocking(move || {
        let t = git::remote::resolve_push_target(&git::open(&rp)?, remote.as_deref(), branch.as_deref())?;
        Ok((t.remote, t.branch, t.remote_branch))
    })
    .await?;

    // LFS objects first (like git-lfs' pre-push hook).
    let c = ctx(&app, &state, &repo_path, "lfs-upload");
    let lfs_uploaded = crate::lfs::upload_for_push(
        app.clone(),
        &state,
        repo_path.clone(),
        target_remote.clone(),
        target_branch.clone(),
    )
    .await;
    c.done(None);
    let lfs_uploaded = lfs_uploaded?;

    let c = ctx(&app, &state, &repo_path, "push");
    let c2 = c.clone();
    let t = git::remote::PushTarget {
        remote: target_remote.clone(),
        branch: target_branch.clone(),
        remote_branch: target_remote_branch.clone(),
    };
    let r = blocking(move || git::remote::push(&c2, &git::open(&repo_path)?, &t, force, set_upstream)).await;
    c.done(None);
    r?;
    Ok(PushResult {
        remote: target_remote,
        branch: target_branch,
        remote_branch: target_remote_branch,
        lfs_uploaded,
    })
}

#[tauri::command]
pub async fn delete_remote_branch(app: AppHandle, state: State<'_, AppState>, repo_path: String, remote: String, branch: String) -> AppResult<()> {
    let c = ctx(&app, &state, &repo_path, "push");
    let c2 = c.clone();
    let r = blocking(move || git::remote::delete_remote_branch(&c2, &git::open(&repo_path)?, &remote, &branch)).await;
    c.done(None);
    r
}

#[tauri::command]
pub async fn push_tag(app: AppHandle, state: State<'_, AppState>, repo_path: String, remote: String, name: String) -> AppResult<()> {
    let c = ctx(&app, &state, &repo_path, "push");
    let c2 = c.clone();
    let r = blocking(move || git::remote::push_tag(&c2, &git::open(&repo_path)?, &remote, &name)).await;
    c.done(None);
    r
}

// ----- merge & friends ----------------------------------------------------

#[tauri::command]
pub async fn merge_branch(state: State<'_, AppState>, repo_path: String, source: String, ff_only: bool) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::merge::merge_branch(&git::open(&repo_path)?, &settings, &source, ff_only)).await
}

#[tauri::command]
pub async fn abort_operation(repo_path: String) -> AppResult<()> {
    blocking(move || git::merge::abort_operation(&git::open(&repo_path)?)).await
}

#[tauri::command]
pub async fn resolve_conflict(repo_path: String, path: String, side: String) -> AppResult<()> {
    blocking(move || git::merge::resolve_conflict(&git::open(&repo_path)?, &path, &side)).await
}

/// Show a file in Explorer / Finder / the file manager. A path that no
/// longer exists (deleted file) opens its nearest existing folder instead.
#[tauri::command]
pub fn reveal_path(path: String) -> AppResult<()> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| crate::error::AppError::Msg(format!("Cannot open the file manager: {e}")));
    }
    let mut dir = p.parent();
    while let Some(d) = dir {
        if d.is_dir() {
            return tauri_plugin_opener::open_path(d, None::<&str>).map_err(|e| crate::error::AppError::Msg(format!("Cannot open the file manager: {e}")));
        }
        dir = d.parent();
    }
    crate::error::err("The path does not exist")
}

#[tauri::command]
pub async fn resolve_conflict_block(repo_path: String, path: String, block: usize, choice: String) -> AppResult<usize> {
    blocking(move || git::merge::resolve_conflict_block(&git::open(&repo_path)?, &path, block, &choice)).await
}

#[tauri::command]
pub async fn rebase_branch(state: State<'_, AppState>, repo_path: String, onto: String) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::rebase::rebase_onto(&git::open(&repo_path)?, &settings, &onto)).await
}

#[tauri::command]
pub async fn rebase_continue(state: State<'_, AppState>, repo_path: String) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::rebase::rebase_continue(&git::open(&repo_path)?, &settings)).await
}

#[tauri::command]
pub async fn rebase_skip(state: State<'_, AppState>, repo_path: String) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::rebase::rebase_skip(&git::open(&repo_path)?, &settings)).await
}

#[tauri::command]
pub async fn cherry_pick(state: State<'_, AppState>, repo_path: String, oid: String) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::merge::cherry_pick(&git::open(&repo_path)?, &settings, &oid)).await
}

#[tauri::command]
pub async fn revert_commit(state: State<'_, AppState>, repo_path: String, oid: String) -> AppResult<MergeResult> {
    let settings = state.settings();
    blocking(move || git::merge::revert(&git::open(&repo_path)?, &settings, &oid)).await
}

#[tauri::command]
pub async fn reset_to(repo_path: String, oid: String, mode: String) -> AppResult<()> {
    blocking(move || git::merge::reset(&git::open(&repo_path)?, &oid, &mode)).await
}

// ----- stash --------------------------------------------------------------

#[tauri::command]
pub async fn stash_save(state: State<'_, AppState>, repo_path: String, message: Option<String>, include_untracked: bool) -> AppResult<String> {
    let settings = state.settings();
    blocking(move || git::stash::save(&mut git::open(&repo_path)?, &settings, message.as_deref(), include_untracked)).await
}

#[tauri::command]
pub async fn stash_apply(repo_path: String, index: usize, pop: bool) -> AppResult<()> {
    blocking(move || git::stash::apply(&mut git::open(&repo_path)?, index, pop)).await
}

#[tauri::command]
pub async fn stash_drop(repo_path: String, index: usize) -> AppResult<()> {
    blocking(move || git::stash::drop(&mut git::open(&repo_path)?, index)).await
}

// ----- tags ---------------------------------------------------------------

#[tauri::command]
pub async fn create_tag(state: State<'_, AppState>, repo_path: String, name: String, target: Option<String>, message: Option<String>) -> AppResult<()> {
    let settings = state.settings();
    blocking(move || git::tags::create(&git::open(&repo_path)?, &settings, &name, target.as_deref(), message.as_deref())).await
}

#[tauri::command]
pub async fn delete_tag(repo_path: String, name: String) -> AppResult<()> {
    blocking(move || git::tags::delete(&git::open(&repo_path)?, &name)).await
}

// ----- author -------------------------------------------------------------

#[tauri::command]
pub async fn get_author(state: State<'_, AppState>, repo_path: String) -> AppResult<AuthorInfo> {
    let settings = state.settings();
    blocking(move || git::repo::author(&git::open(&repo_path)?, &settings)).await
}

#[tauri::command]
pub async fn set_author(repo_path: Option<String>, name: String, email: String, global: bool) -> AppResult<()> {
    blocking(move || {
        let repo = match &repo_path {
            Some(p) => Some(git::open(p)?),
            None => None,
        };
        git::repo::set_author(repo.as_ref(), name.trim(), email.trim(), global)
    })
    .await
}

// ----- LFS ----------------------------------------------------------------

#[tauri::command]
pub async fn lfs_info(state: State<'_, AppState>, repo_path: String) -> AppResult<LfsInfo> {
    let creds = state.credentials();
    blocking(move || crate::lfs::info(&git::open(&repo_path)?, &creds)).await
}

#[tauri::command]
pub async fn lfs_track(repo_path: String, pattern: String) -> AppResult<()> {
    blocking(move || crate::lfs::track(&git::open(&repo_path)?, &pattern)).await
}

#[tauri::command]
pub async fn lfs_untrack(repo_path: String, pattern: String) -> AppResult<()> {
    blocking(move || crate::lfs::untrack(&git::open(&repo_path)?, &pattern)).await
}

#[tauri::command]
pub async fn lfs_fetch(app: AppHandle, state: State<'_, AppState>, repo_path: String, remote: Option<String>) -> AppResult<LfsReport> {
    let c = ctx(&app, &state, &repo_path, "lfs-download");
    let r = crate::lfs::fetch_and_smudge(app.clone(), &state, repo_path, remote).await;
    c.done(None);
    r
}

#[tauri::command]
pub async fn file_size(repo_path: String, path: String) -> AppResult<u64> {
    blocking(move || {
        let repo = git::open(&repo_path)?;
        Ok(std::fs::metadata(workdir(&repo)?.join(path)).map(|m| m.len()).unwrap_or(0))
    })
    .await
}

// ----- accounts -----------------------------------------------------------

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Vec<Account> {
    state.config().accounts
}

#[tauri::command]
pub fn remove_account(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::auth::remove_account(&state, &id);
    Ok(())
}

#[tauri::command]
pub async fn github_login(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: Option<String>,
    client_secret: Option<String>,
    base_url: Option<String>,
    account_id: Option<String>,
) -> AppResult<Account> {
    // Renewing an existing account whose token still works needs no browser trip.
    if let Some(id) = account_id.as_deref() {
        let existing = state.config().accounts.into_iter().find(|a| a.id == id);
        if let (Some(acc), Some(tok)) = (existing, crate::secrets::get_token(id)) {
            let meta = crate::auth::provider_meta(Provider::Github, &acc.web_base)?;
            if crate::auth::api::fetch_profile(&state.http, Provider::Github, &meta, "", &tok).await.is_ok() {
                return crate::auth::finish_login(&app, &state, Provider::Github, meta, &acc.auth_kind, "", &tok).await;
            }
        }
    }
    // Resolution order: id typed in the dialog > id saved in Settings > built-in id.
    let explicit = client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let from_settings = Some(state.settings().github_client_id.trim().to_string()).filter(|c| !c.is_empty());
    let builtin = config::builtin_github_client_id().map(String::from);
    let cid = explicit.clone().or(from_settings).or(builtin).unwrap_or_default();
    // Settings may still hold a copy of the built-in id from older versions.
    let using_builtin_id = config::builtin_github_client_id().map(|b| b == cid).unwrap_or(false);
    if let Some(c) = explicit {
        // Remember a user-provided id only when nothing is built in.
        if config::builtin_github_client_id().is_none() && state.settings().github_client_id != c {
            state.update(|cfg| cfg.settings.github_client_id = c);
        }
    }
    // A client secret selects the browser flow. The built-in secret only ever
    // pairs with the built-in id; a user-provided one is remembered in Settings.
    let explicit_secret = client_secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let secret = if using_builtin_id {
        config::builtin_github_client_secret().map(String::from)
    } else {
        if let Some(s) = &explicit_secret {
            if state.settings().github_client_secret != *s {
                let s = s.clone();
                state.update(|cfg| cfg.settings.github_client_secret = s);
            }
        }
        explicit_secret.or_else(|| Some(state.settings().github_client_secret.trim().to_string()).filter(|s| !s.is_empty()))
    };
    let base = base_url.as_deref().unwrap_or("");
    match secret {
        Some(s) => crate::auth::github::web_login(&app, &state, &cid, &s, base).await,
        None => crate::auth::github::device_login(&app, &state, &cid, base).await,
    }
}

#[tauri::command]
pub async fn oauth_pkce_login(app: AppHandle, state: State<'_, AppState>, provider: Provider, base_url: String, client_id: String) -> AppResult<Account> {
    crate::auth::oauth::pkce_login(&app, &state, provider, &base_url, &client_id).await
}

#[tauri::command]
pub async fn token_login(app: AppHandle, state: State<'_, AppState>, provider: Provider, base_url: String, username: Option<String>, token: String) -> AppResult<Account> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token / password is required".into());
    }
    let meta = crate::auth::provider_meta(provider, &base_url)?;
    let kind = if provider == Provider::Bitbucket || provider == Provider::Generic { "basic" } else { "token" };
    crate::auth::finish_login(&app, &state, provider, meta, kind, username.as_deref().unwrap_or(""), &token).await
}

#[tauri::command]
pub fn cancel_login(state: State<'_, AppState>) {
    state.login_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn list_remote_repos(state: State<'_, AppState>, account_id: String) -> AppResult<Vec<RemoteRepo>> {
    let account = state
        .config()
        .accounts
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or("Unknown account")?;
    let token = crate::secrets::get_token(&account.id).ok_or("No stored token for this account; sign in again")?;
    crate::auth::api::list_repos(&state.http, &account, &token).await
}
