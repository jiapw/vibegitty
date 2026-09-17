// Mirrors of the Rust types (serde camelCase).

export interface HeadInfo {
  branch: string | null;
  oid: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface RepoInfo {
  path: string;
  name: string;
  head: HeadInfo;
  state: string;
  lfsEnabled: boolean;
}

export type RefKind = "local" | "remote" | "tag";

export interface RefInfo {
  name: string;
  fullName: string;
  kind: RefKind;
  oid: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  message: string | null;
}

export interface CommitInfo {
  oid: string;
  shortOid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  time: number;
  authorTime: number;
  summary: string;
  body: string;
}

export interface LogPage {
  commits: CommitInfo[];
  hasMore: boolean;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted"
  | string;

export interface StatusEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  isLfs: boolean;
  size: number;
  /** Untracked files: deepest ancestor directory that already contains tracked files. */
  trackedParent: string | null;
}

export interface WorkingStatus {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  conflicted: StatusEntry[];
  state: string;
  mergeMessage: string | null;
  mergeHeads: string[];
  /** "step/total" while a rebase is in progress. */
  rebaseProgress: string | null;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

export interface StashInfo {
  index: number;
  message: string;
  oid: string;
  time: number;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface CommitDetail {
  commit: CommitInfo;
  files: CommitFile[];
  additions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  oldLineno: number | null;
  newLineno: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  isBinary: boolean;
  isLfs: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
  note: string | null;
}

export type DiffKind = "unstaged" | "staged" | "commit" | "conflict";

export interface DiffTarget {
  kind: DiffKind;
  oid?: string | null;
  path: string;
  oldPath?: string | null;
  /** Request the whole file as context (side-by-side view). */
  full?: boolean;
}

export interface MergeResult {
  kind: "up_to_date" | "fast_forward" | "merged" | "rebased" | "conflicts";
  oid: string | null;
  conflicts: string[];
}

export interface PushResult {
  remote: string;
  branch: string;
  remoteBranch: string;
  lfsUploaded: number;
}

export interface LfsReport {
  downloaded: number;
  smudged: number;
  uploaded: number;
  failed: string[];
}

export interface PullResult {
  remote: string;
  merge: MergeResult;
  lfs: LfsReport | null;
}

export interface ProgressEvent {
  repo: string;
  op: string;
  phase: string;
  current: number;
  total: number;
  bytes: number;
  message: string | null;
  done: boolean;
}

export interface AuthorInfo {
  name: string;
  email: string;
  source: string;
}

export interface LfsInfo {
  enabled: boolean;
  patterns: string[];
  pendingPointers: number;
  localObjects: number;
  endpoint: string | null;
}

export interface RemoteRepo {
  fullName: string;
  cloneUrl: string;
  sshUrl: string | null;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
  defaultBranch: string | null;
}

export type Provider = "github" | "gitlab" | "gitea" | "bitbucket" | "generic";

export interface Account {
  id: string;
  provider: Provider;
  host: string;
  apiBase: string;
  webBase: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  tokenUsername: string;
  authKind: string;
}

export interface Settings {
  authorName: string;
  authorEmail: string;
  githubClientId: string;
  githubClientSecret: string;
  oauthRedirectPort: number;
  defaultCloneDir: string;
  commitPageSize: number;
  largeFileWarnMb: number;
  theme: "system" | "dark" | "light";
}

export interface AppConfig {
  openRepos: string[];
  activeRepo: string | null;
  recentRepos: string[];
  accounts: Account[];
  settings: Settings;
  ui: Record<string, unknown>;
}

export interface AppInfo {
  version: string;
  portable: boolean;
  builtinGithubClientId: boolean;
  /** A client secret is built in: github.com sign-in completes in the browser. */
  githubBrowserLogin: boolean;
}

export interface AuthStatus {
  stage: string;
  userCode: string | null;
  verificationUri: string | null;
  expiresIn: number | null;
  message: string | null;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
  bitbucket: "Bitbucket",
  generic: "Other git server",
};
