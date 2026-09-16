use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head: HeadInfo,
    pub state: String,
    pub lfs_enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub name: String,
    pub full_name: String,
    /// `local` | `remote` | `tag`
    pub kind: String,
    pub oid: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub remote: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub committer_name: String,
    pub committer_email: String,
    /// Committer time, unix seconds.
    pub time: i64,
    pub author_time: i64,
    pub summary: String,
    pub body: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<CommitInfo>,
    pub has_more: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    /// added | modified | deleted | renamed | typechange | untracked | conflicted
    pub status: String,
    pub is_lfs: bool,
    pub size: u64,
    /// For untracked files: the deepest ancestor directory that already
    /// contains tracked files (`None` if no ancestor does). Directories at or
    /// above it are not sensible `.gitignore` targets.
    pub tracked_parent: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
    /// clean | merge | revert | cherrypick | rebase | bisect | mailbox
    pub state: String,
    pub merge_message: Option<String>,
    pub merge_heads: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
    pub time: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub is_binary: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: CommitInfo,
    pub files: Vec<CommitFile>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// context | add | del
    pub kind: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub is_binary: bool,
    pub is_lfs: bool,
    pub hunks: Vec<DiffHunk>,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
    pub note: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffTarget {
    /// unstaged | staged | commit | conflict
    pub kind: String,
    pub oid: Option<String>,
    pub path: String,
    pub old_path: Option<String>,
    /// Include the whole file as context (for side-by-side views).
    #[serde(default)]
    pub full: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// up_to_date | fast_forward | merged | conflicts
    pub kind: String,
    pub oid: Option<String>,
    pub conflicts: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    pub branch: String,
    pub remote_branch: String,
    pub lfs_uploaded: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub remote: String,
    pub merge: MergeResult,
    pub lfs: Option<LfsReport>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub repo: String,
    /// fetch | push | clone | lfs-download | lfs-upload | checkout
    pub op: String,
    pub phase: String,
    pub current: u64,
    pub total: u64,
    pub bytes: u64,
    pub message: Option<String>,
    pub done: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthorInfo {
    pub name: String,
    pub email: String,
    /// repo | global | settings | none
    pub source: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LfsInfo {
    pub enabled: bool,
    pub patterns: Vec<String>,
    pub pending_pointers: usize,
    pub local_objects: usize,
    pub endpoint: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LfsReport {
    pub downloaded: usize,
    pub smudged: usize,
    pub uploaded: usize,
    pub failed: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: Option<String>,
    pub private: bool,
    pub description: Option<String>,
    pub updated_at: Option<String>,
    pub default_branch: Option<String>,
}
