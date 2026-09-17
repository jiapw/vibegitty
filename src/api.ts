import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AppConfig,
  AppInfo,
  AuthorInfo,
  CommitDetail,
  DiffTarget,
  FileDiff,
  LfsInfo,
  LfsReport,
  LogPage,
  MergeResult,
  Provider,
  PullResult,
  PushResult,
  RefInfo,
  RemoteInfo,
  RemoteRepo,
  RepoInfo,
  Settings,
  StashInfo,
  WorkingStatus,
} from "./types";

export const api = {
  // config
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  saveUiPrefs: (prefs: Record<string, unknown>) => invoke<void>("save_ui_prefs", { prefs }),
  removeRecentRepo: (path: string) => invoke<void>("remove_recent_repo", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  setActiveRepo: (path: string | null) => invoke<void>("set_active_repo", { path }),
  closeRepo: (path: string) => invoke<void>("close_repo", { path }),

  // repositories
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  initRepo: (path: string) => invoke<RepoInfo>("init_repo", { path }),
  cloneRepo: (url: string, dest: string) => invoke<RepoInfo>("clone_repo", { url, dest }),
  getRepoInfo: (repoPath: string) => invoke<RepoInfo>("get_repo_info", { repoPath }),
  getRefs: (repoPath: string) => invoke<RefInfo[]>("get_refs", { repoPath }),
  getLog: (repoPath: string, skip: number, limit: number) => invoke<LogPage>("get_log", { repoPath, skip, limit }),
  getStatus: (repoPath: string) => invoke<WorkingStatus>("get_status", { repoPath }),
  getRemotes: (repoPath: string) => invoke<RemoteInfo[]>("get_remotes", { repoPath }),
  addRemote: (repoPath: string, name: string, url: string) => invoke<void>("add_remote", { repoPath, name, url }),
  removeRemote: (repoPath: string, name: string) => invoke<void>("remove_remote", { repoPath, name }),
  getStashes: (repoPath: string) => invoke<StashInfo[]>("get_stashes", { repoPath }),
  addGitignorePatterns: (repoPath: string, patterns: string[]) =>
    invoke<number>("add_gitignore_patterns", { repoPath, patterns }),
  getCommitDetail: (repoPath: string, oid: string) => invoke<CommitDetail>("get_commit_detail", { repoPath, oid }),
  getDiff: (repoPath: string, target: DiffTarget) => invoke<FileDiff>("get_diff", { repoPath, target }),

  // staging & commit
  stagePaths: (repoPath: string, paths: string[]) => invoke<void>("stage_paths", { repoPath, paths }),
  unstagePaths: (repoPath: string, paths: string[]) => invoke<void>("unstage_paths", { repoPath, paths }),
  stageAll: (repoPath: string) => invoke<void>("stage_all", { repoPath }),
  unstageAll: (repoPath: string) => invoke<void>("unstage_all", { repoPath }),
  discardPaths: (repoPath: string, paths: string[]) => invoke<void>("discard_paths", { repoPath, paths }),
  discardAll: (repoPath: string) => invoke<void>("discard_all", { repoPath }),
  commit: (repoPath: string, message: string, amend: boolean) => invoke<string>("commit", { repoPath, message, amend }),

  // branches
  createBranch: (repoPath: string, name: string, target: string | null, checkout: boolean) =>
    invoke<void>("create_branch", { repoPath, name, target, checkout }),
  checkoutBranch: (repoPath: string, name: string) => invoke<void>("checkout_branch", { repoPath, name }),
  checkoutRemoteBranch: (repoPath: string, remoteBranch: string, localName: string | null) =>
    invoke<string>("checkout_remote_branch", { repoPath, remoteBranch, localName }),
  checkoutCommit: (repoPath: string, oid: string) => invoke<void>("checkout_commit", { repoPath, oid }),
  deleteBranch: (repoPath: string, name: string, force: boolean) => invoke<void>("delete_branch", { repoPath, name, force }),
  renameBranch: (repoPath: string, oldName: string, newName: string) =>
    invoke<void>("rename_branch", { repoPath, oldName, newName }),
  setUpstream: (repoPath: string, branch: string, upstream: string | null) =>
    invoke<void>("set_upstream", { repoPath, branch, upstream }),

  // remote operations
  fetch: (repoPath: string, remote: string | null, prune: boolean) => invoke<string[]>("fetch", { repoPath, remote, prune }),
  pull: (repoPath: string, mode: "merge" | "ff" | "rebase") => invoke<PullResult>("pull", { repoPath, mode }),
  rebaseBranch: (repoPath: string, onto: string) => invoke<MergeResult>("rebase_branch", { repoPath, onto }),
  rebaseContinue: (repoPath: string) => invoke<MergeResult>("rebase_continue", { repoPath }),
  rebaseSkip: (repoPath: string) => invoke<MergeResult>("rebase_skip", { repoPath }),
  resolveConflictBlock: (repoPath: string, path: string, block: number, choice: "ours" | "theirs" | "both") =>
    invoke<number>("resolve_conflict_block", { repoPath, path, block, choice }),
  push: (repoPath: string, remote: string | null, branch: string | null, force: boolean, setUpstream: boolean) =>
    invoke<PushResult>("push", { repoPath, remote, branch, force, setUpstream }),
  deleteRemoteBranch: (repoPath: string, remote: string, branch: string) =>
    invoke<void>("delete_remote_branch", { repoPath, remote, branch }),
  pushTag: (repoPath: string, remote: string, name: string) => invoke<void>("push_tag", { repoPath, remote, name }),

  // merge & friends
  mergeBranch: (repoPath: string, source: string, ffOnly: boolean) =>
    invoke<MergeResult>("merge_branch", { repoPath, source, ffOnly }),
  abortOperation: (repoPath: string) => invoke<void>("abort_operation", { repoPath }),
  resolveConflict: (repoPath: string, path: string, side: "ours" | "theirs") =>
    invoke<void>("resolve_conflict", { repoPath, path, side }),
  cherryPick: (repoPath: string, oid: string) => invoke<MergeResult>("cherry_pick", { repoPath, oid }),
  revertCommit: (repoPath: string, oid: string) => invoke<MergeResult>("revert_commit", { repoPath, oid }),
  resetTo: (repoPath: string, oid: string, mode: "soft" | "mixed" | "hard") => invoke<void>("reset_to", { repoPath, oid, mode }),

  // stash
  stashSave: (repoPath: string, message: string | null, includeUntracked: boolean) =>
    invoke<string>("stash_save", { repoPath, message, includeUntracked }),
  stashApply: (repoPath: string, index: number, pop: boolean) => invoke<void>("stash_apply", { repoPath, index, pop }),
  stashDrop: (repoPath: string, index: number) => invoke<void>("stash_drop", { repoPath, index }),

  // tags
  createTag: (repoPath: string, name: string, target: string | null, message: string | null) =>
    invoke<void>("create_tag", { repoPath, name, target, message }),
  deleteTag: (repoPath: string, name: string) => invoke<void>("delete_tag", { repoPath, name }),

  // author
  getAuthor: (repoPath: string) => invoke<AuthorInfo>("get_author", { repoPath }),
  setAuthor: (repoPath: string | null, name: string, email: string, global: boolean) =>
    invoke<void>("set_author", { repoPath, name, email, global }),

  // LFS
  lfsInfo: (repoPath: string) => invoke<LfsInfo>("lfs_info", { repoPath }),
  lfsTrack: (repoPath: string, pattern: string) => invoke<void>("lfs_track", { repoPath, pattern }),
  lfsUntrack: (repoPath: string, pattern: string) => invoke<void>("lfs_untrack", { repoPath, pattern }),
  lfsFetch: (repoPath: string, remote: string | null) => invoke<LfsReport>("lfs_fetch", { repoPath, remote }),

  // accounts
  listAccounts: () => invoke<Account[]>("list_accounts"),
  removeAccount: (id: string) => invoke<void>("remove_account", { id }),
  githubLogin: (clientId: string | null, clientSecret: string | null, baseUrl: string | null, accountId: string | null = null) =>
    invoke<Account>("github_login", { clientId, clientSecret, baseUrl, accountId }),
  oauthPkceLogin: (provider: Provider, baseUrl: string, clientId: string) =>
    invoke<Account>("oauth_pkce_login", { provider, baseUrl, clientId }),
  tokenLogin: (provider: Provider, baseUrl: string, username: string | null, token: string) =>
    invoke<Account>("token_login", { provider, baseUrl, username, token }),
  cancelLogin: () => invoke<void>("cancel_login"),
  listRemoteRepos: (accountId: string) => invoke<RemoteRepo[]>("list_remote_repos", { accountId }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
