pub mod auth;
pub mod commands;
pub mod config;
pub mod error;
pub mod git;
pub mod lfs;
pub mod secrets;
pub mod state;
pub mod watcher;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    // Repositories owned by another OS user are fine for a desktop client.
    unsafe {
        let _ = git2::opts::set_verify_owner_validation(false);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::load())
        .setup(|app| {
            let state = app.state::<AppState>();
            let cfg = state.config();
            let handle = app.handle().clone();
            let mut watchers = state.watchers.lock();
            for p in cfg.open_repos {
                if std::path::Path::new(&p).exists() {
                    match watcher::watch(handle.clone(), p.clone()) {
                        Ok(h) => {
                            watchers.insert(p, h);
                        }
                        Err(e) => log::warn!("watcher for {p} not started: {e}"),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_config,
            commands::save_settings,
            commands::save_ui_prefs,
            commands::remove_recent_repo,
            commands::set_active_repo,
            commands::close_repo,
            commands::open_repo,
            commands::init_repo,
            commands::clone_repo,
            commands::get_repo_info,
            commands::get_refs,
            commands::get_log,
            commands::get_status,
            commands::get_remotes,
            commands::add_remote,
            commands::remove_remote,
            commands::add_gitignore_patterns,
            commands::get_stashes,
            commands::get_commit_detail,
            commands::get_diff,
            commands::stage_paths,
            commands::unstage_paths,
            commands::stage_all,
            commands::unstage_all,
            commands::discard_paths,
            commands::discard_all,
            commands::commit,
            commands::create_branch,
            commands::checkout_branch,
            commands::checkout_remote_branch,
            commands::checkout_commit,
            commands::delete_branch,
            commands::rename_branch,
            commands::set_upstream,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::delete_remote_branch,
            commands::push_tag,
            commands::merge_branch,
            commands::abort_operation,
            commands::resolve_conflict,
            commands::resolve_conflict_block,
            commands::reveal_path,
            commands::rebase_branch,
            commands::rebase_continue,
            commands::rebase_skip,
            commands::cherry_pick,
            commands::revert_commit,
            commands::reset_to,
            commands::stash_save,
            commands::stash_apply,
            commands::stash_drop,
            commands::create_tag,
            commands::delete_tag,
            commands::get_author,
            commands::set_author,
            commands::lfs_info,
            commands::lfs_track,
            commands::lfs_untrack,
            commands::lfs_fetch,
            commands::file_size,
            commands::list_accounts,
            commands::remove_account,
            commands::github_login,
            commands::oauth_pkce_login,
            commands::token_login,
            commands::cancel_login,
            commands::list_remote_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
