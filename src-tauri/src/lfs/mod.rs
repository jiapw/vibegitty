//! Built-in Git LFS support. No `git-lfs` binary is required: pointer files,
//! the local object store, the batch API and transfers are handled in-process
//! (via the `git-lfs-*` crates), while `.gitattributes` matching and index
//! bookkeeping go through libgit2.
//!
//! libgit2 has no clean/smudge filter hooks, so LFS files are handled at the
//! application level:
//! * staging an LFS-tracked file stores its content in `.git/lfs/objects` and
//!   writes a pointer blob into the index (with the real file's stat data, so
//!   libgit2 considers the working tree file unmodified);
//! * after checkouts/merges/pulls, pointer files in the working tree are
//!   replaced with the real content ("smudge"), downloading objects on demand;
//! * before a push, LFS objects referenced by the outgoing commits are uploaded.

pub mod ssh;

use crate::error::{blocking, AppError, AppResult};
use crate::git::creds::emit;
use crate::git::types::{LfsInfo, LfsReport, ProgressEvent};
use crate::git::workdir;
use crate::state::{AppState, CredSet};
use git2::{AttrCheckFlags, Delta, Index, IndexEntry, IndexTime, ObjectType, Oid, Repository};
use git_lfs_api::{Auth, ObjectSpec, Ref as LfsRef};
use git_lfs_pointer::{Oid as LfsOid, Pointer, MAX_POINTER_SIZE};
use git_lfs_store::Store;
use git_lfs_transfer::{Event, Report, Transfer, TransferConfig};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Repository / attribute helpers
// ---------------------------------------------------------------------------

pub fn store(repo: &Repository) -> Store {
    Store::new(store_root(repo))
}

pub fn store_root(repo: &Repository) -> PathBuf {
    repo.commondir().join("lfs")
}

fn contains_lfs_filter(bytes: &[u8]) -> bool {
    bytes.windows(10).any(|w| w == b"filter=lfs")
}

fn file_mentions_lfs(path: &Path) -> bool {
    fs::read(path).map(|b| contains_lfs_filter(&b)).unwrap_or(false)
}

static LFS_CACHE: Mutex<Option<HashMap<PathBuf, (Option<SystemTime>, Option<SystemTime>, bool)>>> = Mutex::new(None);

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

/// Does this repository track anything with LFS? Cheap (cached on the index
/// and root `.gitattributes` mtimes) so it can gate every status call.
pub fn repo_uses_lfs(repo: &Repository) -> bool {
    let gitdir = repo.path().to_path_buf();
    let index_mtime = mtime(&gitdir.join("index"));
    let root_attr = repo.workdir().map(|w| w.join(".gitattributes"));
    let attr_mtime = root_attr.as_ref().and_then(|p| mtime(p));
    {
        let cache = LFS_CACHE.lock();
        if let Some(map) = cache.as_ref() {
            if let Some((im, am, v)) = map.get(&gitdir) {
                if *im == index_mtime && *am == attr_mtime {
                    return *v;
                }
            }
        }
    }
    let result = compute_repo_uses_lfs(repo, root_attr.as_deref());
    let mut cache = LFS_CACHE.lock();
    cache
        .get_or_insert_with(HashMap::new)
        .insert(gitdir, (index_mtime, attr_mtime, result));
    result
}

fn compute_repo_uses_lfs(repo: &Repository, root_attr: Option<&Path>) -> bool {
    if let Some(p) = root_attr {
        if file_mentions_lfs(p) {
            return true;
        }
    }
    if file_mentions_lfs(&repo.commondir().join("info").join("attributes")) {
        return true;
    }
    if let Ok(index) = repo.index() {
        for entry in index.iter() {
            if entry.path.ends_with(b".gitattributes") {
                if let Ok(blob) = repo.find_blob(entry.id) {
                    if contains_lfs_filter(blob.content()) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

pub fn invalidate_cache() {
    *LFS_CACHE.lock() = None;
}

pub fn is_lfs_path(repo: &Repository, path: &str) -> bool {
    matches!(
        repo.get_attr(Path::new(path), "filter", AttrCheckFlags::empty()),
        Ok(Some("lfs"))
    )
}

// ---------------------------------------------------------------------------
// Pointer helpers
// ---------------------------------------------------------------------------

pub fn parse_pointer(bytes: &[u8]) -> Option<Pointer> {
    if bytes.is_empty() || bytes.len() > MAX_POINTER_SIZE {
        return None;
    }
    Pointer::parse(bytes).ok()
}

pub fn read_pointer(abs: &Path) -> Option<Pointer> {
    let meta = fs::metadata(abs).ok()?;
    if !meta.is_file() || meta.len() as usize > MAX_POINTER_SIZE {
        return None;
    }
    parse_pointer(&fs::read(abs).ok()?)
}

/// SHA-256 + size of a working tree file, as an LFS pointer.
pub fn hash_file(abs: &Path) -> AppResult<Pointer> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(abs)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    let digest = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&digest);
    Ok(Pointer::new(LfsOid::from_bytes(arr), size))
}

pub fn pointer_text_for_file(abs: &Path) -> AppResult<String> {
    Ok(hash_file(abs)?.encode())
}

fn clean_into_store(st: &Store, abs: &Path) -> AppResult<Pointer> {
    let mut f = File::open(abs)?;
    let (oid, size) = st.insert(&mut f)?;
    Ok(Pointer::new(oid, size))
}

// ---------------------------------------------------------------------------
// Index entry bookkeeping
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn stat_fields(
    meta: &fs::Metadata,
    filemode: bool,
    existing_mode: Option<u32>,
) -> (IndexTime, IndexTime, u32, u32, u32, u32, u32) {
    use std::os::unix::fs::MetadataExt;
    let mode = if filemode {
        if meta.mode() & 0o111 != 0 {
            0o100755
        } else {
            0o100644
        }
    } else {
        existing_mode.unwrap_or(0o100644)
    };
    (
        IndexTime::new(meta.ctime() as i32, meta.ctime_nsec() as u32),
        IndexTime::new(meta.mtime() as i32, meta.mtime_nsec() as u32),
        meta.rdev() as u32,
        meta.ino() as u32,
        meta.uid(),
        meta.gid(),
        mode,
    )
}

#[cfg(windows)]
fn filetime_to_ts(ft: u64) -> (i32, u32) {
    let t = ft as i64 - 116_444_736_000_000_000;
    ((t / 10_000_000) as i32, ((t % 10_000_000) * 100) as u32)
}

#[cfg(windows)]
fn stat_fields(
    meta: &fs::Metadata,
    _filemode: bool,
    existing_mode: Option<u32>,
) -> (IndexTime, IndexTime, u32, u32, u32, u32, u32) {
    use std::os::windows::fs::MetadataExt;
    let ct = filetime_to_ts(meta.creation_time());
    let mt = filetime_to_ts(meta.last_write_time());
    (
        IndexTime::new(ct.0, ct.1),
        IndexTime::new(mt.0, mt.1),
        0,
        0,
        0,
        0,
        existing_mode.unwrap_or(0o100644),
    )
}

fn index_entry_for(repo: &Repository, index: &Index, rel: &str, abs: &Path, id: Oid) -> AppResult<IndexEntry> {
    let existing_mode = index.get_path(Path::new(rel), 0).map(|e| e.mode);
    let meta = fs::metadata(abs)?;
    let filemode = repo
        .config()
        .and_then(|c| c.get_bool("core.filemode"))
        .unwrap_or(cfg!(unix));
    let (ctime, mtime, dev, ino, uid, gid, mode) = stat_fields(&meta, filemode, existing_mode);
    Ok(IndexEntry {
        ctime,
        mtime,
        dev,
        ino,
        mode,
        uid,
        gid,
        file_size: meta.len() as u32,
        id,
        flags: 0,
        flags_extended: 0,
        path: rel.as_bytes().to_vec(),
    })
}

/// If the file was modified within the last couple of seconds, push its mtime
/// back a little so libgit2's "racy git" check does not force a re-hash (which
/// would compare raw content against the pointer blob and report it modified).
fn avoid_racy_mtime(abs: &Path) {
    let Ok(meta) = fs::metadata(abs) else { return };
    let Ok(modified) = meta.modified() else { return };
    let now = SystemTime::now();
    let recent = now
        .duration_since(modified)
        .map(|d| d < Duration::from_secs(2))
        .unwrap_or(true);
    if recent {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(abs) {
            let _ = f.set_modified(now - Duration::from_secs(3));
        }
    }
}

/// Stage an LFS-tracked working tree file: content goes to the local LFS
/// store, a pointer blob goes into the index.
pub fn stage_lfs_file(repo: &Repository, index: &mut Index, rel: &str) -> AppResult<()> {
    let abs = workdir(repo)?.join(rel);
    if read_pointer(&abs).is_some() {
        // Already a pointer (not smudged yet): stage verbatim.
        index.add_path(Path::new(rel))?;
        return Ok(());
    }
    let pointer = clean_into_store(&store(repo), &abs)?;
    let blob_id = repo.blob(pointer.encode().as_bytes())?;
    avoid_racy_mtime(&abs);
    let entry = index_entry_for(repo, index, rel, &abs, blob_id)?;
    index.add(&entry)?;
    Ok(())
}

/// For LFS paths that libgit2 reports as modified: re-hash the working tree
/// file and, if it still matches the staged pointer, refresh the cached stat
/// data. Returns the set of paths that are actually unmodified.
pub fn verify_unmodified(repo: &Repository, paths: &[String]) -> AppResult<HashSet<String>> {
    let wd = workdir(repo)?;
    let mut index = repo.index()?;
    let mut clean = HashSet::new();
    let mut dirty = false;
    for rel in paths {
        let Some(entry) = index.get_path(Path::new(rel), 0) else { continue };
        let abs = wd.join(rel);
        if !abs.is_file() {
            continue;
        }
        let Ok(pointer) = hash_file(&abs) else { continue };
        let expected = Oid::hash_object(ObjectType::Blob, pointer.encode().as_bytes())?;
        if expected == entry.id {
            avoid_racy_mtime(&abs);
            let e = index_entry_for(repo, &index, rel, &abs, entry.id)?;
            index.add(&e)?;
            dirty = true;
            clean.insert(rel.clone());
        }
    }
    if dirty {
        index.write()?;
    }
    Ok(clean)
}

// ---------------------------------------------------------------------------
// Smudge (pointer -> content)
// ---------------------------------------------------------------------------

/// LFS-tracked index entries whose working tree file is still a pointer.
///
/// Fast path (used on every refresh): only index entries whose recorded file
/// size is pointer-sized are examined. libgit2 keeps that size accurate for
/// files it checked out, so this is exact after checkouts, pulls and clones.
pub fn pending_pointers(repo: &Repository) -> AppResult<Vec<(String, Pointer)>> {
    scan_pending_pointers(repo, false)
}

/// Thorough scan (used for an explicit "fetch LFS objects"): also catches
/// pointer files written by other tools without updating the index stat data.
pub fn pending_pointers_thorough(repo: &Repository) -> AppResult<Vec<(String, Pointer)>> {
    scan_pending_pointers(repo, true)
}

fn scan_pending_pointers(repo: &Repository, thorough: bool) -> AppResult<Vec<(String, Pointer)>> {
    let wd = workdir(repo)?;
    let index = repo.index()?;
    let mut out = Vec::new();
    for entry in index.iter() {
        if (entry.flags >> 12) & 0b11 != 0 {
            continue; // conflict stages
        }
        if !thorough && entry.file_size as usize > MAX_POINTER_SIZE {
            continue;
        }
        let rel = String::from_utf8_lossy(&entry.path).to_string();
        if !is_lfs_path(repo, &rel) {
            continue;
        }
        if let Some(p) = read_pointer(&wd.join(&rel)) {
            out.push((rel, p));
        }
    }
    Ok(out)
}

/// Replace pointer files with content from the local store. Returns
/// `(smudged, still missing)`.
fn smudge_entries(repo: &Repository, items: &[(String, Pointer)]) -> AppResult<(usize, Vec<(String, Pointer)>)> {
    let wd = workdir(repo)?;
    let st = store(repo);
    let mut index = repo.index()?;
    let mut done = 0usize;
    let mut missing = Vec::new();
    let mut dirty = false;
    for (rel, p) in items {
        if !st.contains_with_size(p.oid, p.size) {
            missing.push((rel.clone(), p.clone()));
            continue;
        }
        let abs = wd.join(rel);
        let file_name = abs
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "lfs".into());
        let tmp = abs.with_file_name(format!(".{file_name}.vibegitty-lfs-tmp"));
        {
            let mut src = st.open(p.oid)?;
            let mut dst = File::create(&tmp)?;
            std::io::copy(&mut src, &mut dst)?;
        }
        if let Ok(meta) = fs::metadata(&abs) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        fs::rename(&tmp, &abs)?;
        avoid_racy_mtime(&abs);
        if let Some(entry) = index.get_path(Path::new(rel), 0) {
            let e = index_entry_for(repo, &index, rel, &abs, entry.id)?;
            index.add(&e)?;
            dirty = true;
        }
        done += 1;
    }
    if dirty {
        index.write()?;
    }
    Ok((done, missing))
}

/// Smudge every pending pointer whose object is available locally.
/// Returns `(smudged, missing)` counts.
pub fn smudge_all_local(repo: &Repository) -> AppResult<(usize, usize)> {
    let items = pending_pointers(repo)?;
    if items.is_empty() {
        return Ok((0, 0));
    }
    let (done, missing) = smudge_entries(repo, &items)?;
    Ok((done, missing.len()))
}

pub fn smudge_paths_local(repo: &Repository, paths: &[String]) -> AppResult<usize> {
    let wd = workdir(repo)?;
    let items: Vec<(String, Pointer)> = paths
        .iter()
        .filter(|p| is_lfs_path(repo, p))
        .filter_map(|p| read_pointer(&wd.join(p)).map(|ptr| (p.clone(), ptr)))
        .collect();
    if items.is_empty() {
        return Ok(0);
    }
    Ok(smudge_entries(repo, &items)?.0)
}

// ---------------------------------------------------------------------------
// Push support: which objects does the remote still need?
// ---------------------------------------------------------------------------

pub fn objects_for_push(repo: &Repository, remote_name: &str, local_tip: Oid) -> AppResult<Vec<Pointer>> {
    let mut walk = repo.revwalk()?;
    walk.push(local_tip)?;
    for r in repo.references_glob(&format!("refs/remotes/{remote_name}/*"))? {
        if let Some(oid) = r?.target() {
            let _ = walk.hide(oid);
        }
    }
    let odb = repo.odb()?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for oid in walk {
        let c = repo.find_commit(oid?)?;
        let tree = c.tree()?;
        let parent_tree = match c.parent(0) {
            Ok(p) => Some(p.tree()?),
            Err(_) => None,
        };
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
        for d in diff.deltas() {
            if !matches!(
                d.status(),
                Delta::Added | Delta::Modified | Delta::Renamed | Delta::Copied | Delta::Typechange
            ) {
                continue;
            }
            let id = d.new_file().id();
            if id.is_zero() {
                continue;
            }
            let Ok((size, kind)) = odb.read_header(id) else { continue };
            if kind != ObjectType::Blob || size == 0 || size > MAX_POINTER_SIZE {
                continue;
            }
            let blob = repo.find_blob(id)?;
            if let Some(p) = parse_pointer(blob.content()) {
                if seen.insert(p.oid.to_string()) {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

pub struct Endpoint {
    pub url: url::Url,
    pub auth: Auth,
    pub ssh: Option<ssh::SshTarget>,
    pub display: String,
}

fn token_user(a: &crate::config::Account) -> String {
    if a.token_username.is_empty() {
        a.username.clone()
    } else {
        a.token_username.clone()
    }
}

fn auth_for(creds: &CredSet, url: &str) -> Auth {
    match creds.for_url(url) {
        Some((a, t)) => Auth::Basic {
            username: token_user(a),
            password: t.to_string(),
        },
        None => Auth::None,
    }
}

fn https_lfs_url(remote_url: &str) -> AppResult<url::Url> {
    let mut s = remote_url.trim_end_matches('/').to_string();
    if !s.ends_with(".git") {
        s.push_str(".git");
    }
    s.push_str("/info/lfs");
    Ok(url::Url::parse(&s)?)
}

fn lfsconfig_url(repo: &Repository, remote_name: &str) -> Option<String> {
    let p = workdir(repo).ok()?.join(".lfsconfig");
    let cfg = git2::Config::open(&p).ok()?;
    cfg.get_string(&format!("remote.{remote_name}.lfsurl"))
        .ok()
        .or_else(|| cfg.get_string("lfs.url").ok())
}

fn ssh_endpoint(user: &str, host: &str, port: u16, path: &str, creds: &CredSet) -> AppResult<Endpoint> {
    let path = path.trim_start_matches('/');
    let https = format!("https://{host}/{path}");
    let fallback = https_lfs_url(&https)?;
    Ok(Endpoint {
        url: fallback,
        auth: auth_for(creds, &https),
        ssh: Some(ssh::SshTarget {
            user: user.to_string(),
            host: host.to_string(),
            port,
            path: path.to_string(),
        }),
        display: format!("ssh://{user}@{host}:{port}/{path} (git-lfs-authenticate)"),
    })
}

pub fn endpoint(repo: &Repository, remote_name: &str, creds: &CredSet) -> AppResult<Endpoint> {
    let cfg = repo.config()?;
    let remote = repo.find_remote(remote_name)?;
    let remote_url = remote
        .url()
        .map_err(|_| AppError::Lfs(format!("remote '{remote_name}' has no valid URL")))?
        .to_string();

    let explicit = cfg
        .get_string(&format!("remote.{remote_name}.lfsurl"))
        .ok()
        .or_else(|| cfg.get_string("lfs.url").ok())
        .or_else(|| lfsconfig_url(repo, remote_name));
    if let Some(u) = explicit {
        let url = url::Url::parse(&u)?;
        return Ok(Endpoint {
            auth: auth_for(creds, &u),
            url,
            ssh: None,
            display: u,
        });
    }

    if remote_url.contains("://") {
        let u = url::Url::parse(&remote_url)?;
        return match u.scheme() {
            "http" | "https" => {
                let e = https_lfs_url(&remote_url)?;
                Ok(Endpoint {
                    display: e.to_string(),
                    auth: auth_for(creds, &remote_url),
                    url: e,
                    ssh: None,
                })
            }
            "ssh" | "git+ssh" | "ssh+git" => {
                let host = u.host_str().ok_or_else(|| AppError::Lfs("invalid ssh URL".into()))?;
                let user = if u.username().is_empty() { "git" } else { u.username() };
                let port = u.port().unwrap_or(22);
                ssh_endpoint(user, host, port, u.path(), creds)
            }
            "file" => Err(AppError::Lfs("LFS is not available for local file remotes".into())),
            other => Err(AppError::Lfs(format!("unsupported remote URL scheme '{other}'"))),
        };
    }

    if let Some((head, path)) = remote_url.split_once(':') {
        if !head.contains('/') && head.len() > 1 {
            let (user, host) = match head.rsplit_once('@') {
                Some((u, h)) => (u, h),
                None => ("git", head),
            };
            return ssh_endpoint(user, host, 22, path, creds);
        }
    }
    Err(AppError::Lfs(format!(
        "cannot derive an LFS endpoint from remote URL '{remote_url}'"
    )))
}

fn build_client(ep: &Endpoint, http: reqwest::Client) -> git_lfs_api::Client {
    let mut c = git_lfs_api::Client::with_http_client(ep.url.clone(), ep.auth.clone(), http);
    if let Some(t) = &ep.ssh {
        c = c.with_ssh_resolver(Arc::new(ssh::Ssh2Resolver::new(t.clone())));
    }
    c
}

pub fn default_remote(repo: &Repository) -> Option<String> {
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Ok(name) = head.name() {
                if let Ok(buf) = repo.branch_upstream_remote(name) {
                    if let Ok(s) = buf.as_str() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    let remotes = crate::git::remote_names(repo).ok()?;
    if remotes.iter().any(|r| r == "origin") {
        return Some("origin".into());
    }
    remotes.first().cloned()
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

fn human_bytes(b: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

async fn run_transfer(
    app: &AppHandle,
    repo_key: &str,
    op: &str,
    transfer: Transfer,
    objects: Vec<ObjectSpec>,
    lfs_ref: Option<LfsRef>,
    upload: bool,
) -> AppResult<Report> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Event>();
    let total = objects.len() as u64;
    let total_bytes: u64 = objects.iter().map(|o| o.size).sum();
    let app2 = app.clone();
    let repo2 = repo_key.to_string();
    let op2 = op.to_string();
    let forwarder = tauri::async_runtime::spawn(async move {
        let mut done = 0u64;
        let mut bytes: HashMap<String, u64> = HashMap::new();
        let mut last = Instant::now() - Duration::from_secs(1);
        while let Some(ev) = rx.recv().await {
            match ev {
                Event::Started { .. } => {}
                Event::Progress { oid, bytes_done } => {
                    bytes.insert(oid, bytes_done);
                }
                Event::Completed { oid } => {
                    done += 1;
                    bytes.entry(oid).and_modify(|b| *b = *b.max(&mut 0));
                }
                Event::Failed { oid, error } => {
                    done += 1;
                    log::warn!("lfs transfer failed for {oid}: {error}");
                }
            }
            if last.elapsed() >= Duration::from_millis(100) || done == total {
                last = Instant::now();
                let sum: u64 = bytes.values().sum();
                emit(
                    &app2,
                    ProgressEvent {
                        repo: repo2.clone(),
                        op: op2.clone(),
                        phase: "transfer".into(),
                        current: done,
                        total,
                        bytes: sum,
                        message: Some(format!(
                            "{} objects, {} / {}",
                            total,
                            human_bytes(sum.min(total_bytes)),
                            human_bytes(total_bytes)
                        )),
                        done: false,
                    },
                );
            }
        }
    });
    let report = if upload {
        transfer.upload(objects, lfs_ref, Some(tx)).await?
    } else {
        transfer.download(objects, lfs_ref, Some(tx)).await?
    };
    let _ = forwarder.await;
    Ok(report)
}

fn head_refname(repo: &Repository) -> Option<String> {
    let h = repo.head().ok()?;
    if h.is_branch() {
        h.name().ok().map(String::from)
    } else {
        None
    }
}

/// Download every missing LFS object referenced by the working tree and
/// replace the pointer files with real content.
pub async fn fetch_and_smudge(
    app: AppHandle,
    state: &AppState,
    repo_path: String,
    remote_name: Option<String>,
) -> AppResult<LfsReport> {
    let creds = state.credentials();
    let rp = repo_path.clone();
    let (smudged, missing, ep, refname, root) = blocking(move || {
        let repo = crate::git::open(&rp)?;
        let items = pending_pointers_thorough(&repo)?;
        let (smudged, missing) = smudge_entries(&repo, &items)?;
        if missing.is_empty() {
            return Ok((smudged, missing, None, None, store_root(&repo)));
        }
        let remote = remote_name
            .filter(|r| !r.is_empty())
            .or_else(|| default_remote(&repo))
            .ok_or_else(|| AppError::Lfs("no remote available to download LFS objects from".into()))?;
        let ep = endpoint(&repo, &remote, &creds)?;
        Ok((smudged, missing, Some(ep), head_refname(&repo), store_root(&repo)))
    })
    .await?;

    let mut report = LfsReport {
        smudged,
        ..Default::default()
    };
    let Some(ep) = ep else { return Ok(report) };

    let mut specs = Vec::new();
    let mut seen = HashSet::new();
    for (_, p) in &missing {
        if seen.insert(p.oid.to_string()) {
            specs.push(ObjectSpec {
                oid: p.oid.to_string(),
                size: p.size,
            });
        }
    }
    let client = build_client(&ep, state.http.clone());
    let transfer = Transfer::with_http_client(
        client,
        Store::new(root),
        TransferConfig {
            concurrency: 4,
            ..Default::default()
        },
        state.http.clone(),
    );
    let rep = run_transfer(&app, &repo_path, "lfs-download", transfer, specs, refname.map(LfsRef::new), false).await?;
    report.downloaded = rep.succeeded.len();
    report.failed = rep
        .failed
        .iter()
        .map(|(o, e)| format!("{}: {e}", &o[..12.min(o.len())]))
        .collect();

    let rp = repo_path.clone();
    let n = blocking(move || {
        let repo = crate::git::open(&rp)?;
        Ok(smudge_entries(&repo, &missing)?.0)
    })
    .await?;
    report.smudged += n;
    Ok(report)
}

/// Upload LFS objects referenced by commits that `remote` does not have yet.
/// Returns the number of objects the server confirmed.
pub async fn upload_for_push(
    app: AppHandle,
    state: &AppState,
    repo_path: String,
    remote_name: String,
    branch: String,
) -> AppResult<usize> {
    let creds = state.credentials();
    let rp = repo_path.clone();
    let remote2 = remote_name.clone();
    let branch2 = branch.clone();
    let prep = blocking(move || {
        let repo = crate::git::open(&rp)?;
        if !repo_uses_lfs(&repo) {
            return Ok(None);
        }
        let tip = repo
            .find_branch(&branch2, git2::BranchType::Local)?
            .get()
            .target()
            .ok_or_else(|| AppError::Msg("branch has no commits".into()))?;
        let pointers = objects_for_push(&repo, &remote2, tip)?;
        if pointers.is_empty() {
            return Ok(None);
        }
        let st = store(&repo);
        let mut specs = Vec::new();
        let mut missing_local = Vec::new();
        for p in pointers {
            if st.contains_with_size(p.oid, p.size) {
                specs.push(ObjectSpec {
                    oid: p.oid.to_string(),
                    size: p.size,
                });
            } else {
                missing_local.push(p.oid.to_string()[..12].to_string());
            }
        }
        if !missing_local.is_empty() {
            return Err(AppError::Lfs(format!(
                "{} LFS object(s) referenced by the commits to push are missing locally ({}). Run 'LFS fetch' first.",
                missing_local.len(),
                missing_local.join(", ")
            )));
        }
        let ep = endpoint(&repo, &remote2, &creds)?;
        Ok(Some((specs, ep, store_root(&repo))))
    })
    .await?;

    let Some((specs, ep, root)) = prep else { return Ok(0) };
    let client = build_client(&ep, state.http.clone());
    let transfer = Transfer::with_http_client(
        client,
        Store::new(root),
        TransferConfig {
            concurrency: 4,
            ..Default::default()
        },
        state.http.clone(),
    );
    let rep = run_transfer(
        &app,
        &repo_path,
        "lfs-upload",
        transfer,
        specs,
        Some(LfsRef::new(format!("refs/heads/{branch}"))),
        true,
    )
    .await?;
    if !rep.failed.is_empty() {
        let detail: Vec<String> = rep
            .failed
            .iter()
            .take(3)
            .map(|(o, e)| format!("{}: {e}", &o[..12.min(o.len())]))
            .collect();
        return Err(AppError::Lfs(format!(
            "upload failed for {} object(s): {}",
            rep.failed.len(),
            detail.join("; ")
        )));
    }
    Ok(rep.succeeded.len())
}

// ---------------------------------------------------------------------------
// Info / tracking
// ---------------------------------------------------------------------------

pub fn patterns(repo: &Repository) -> Vec<String> {
    let Ok(wd) = workdir(repo) else { return vec![] };
    let Ok(text) = fs::read_to_string(wd.join(".gitattributes")) else { return vec![] };
    text.lines()
        .filter(|l| l.contains("filter=lfs"))
        .filter_map(|l| l.split_whitespace().next())
        .map(String::from)
        .collect()
}

pub fn track(repo: &Repository, pattern: &str) -> AppResult<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(AppError::Lfs("pattern is empty".into()));
    }
    let p = workdir(repo)?.join(".gitattributes");
    let mut content = fs::read_to_string(&p).unwrap_or_default();
    if content
        .lines()
        .any(|l| l.split_whitespace().next() == Some(pattern) && l.contains("filter=lfs"))
    {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("{pattern} filter=lfs diff=lfs merge=lfs -text\n"));
    fs::write(&p, content)?;
    invalidate_cache();
    Ok(())
}

pub fn untrack(repo: &Repository, pattern: &str) -> AppResult<()> {
    let p = workdir(repo)?.join(".gitattributes");
    let content = fs::read_to_string(&p).unwrap_or_default();
    let kept: Vec<&str> = content
        .lines()
        .filter(|l| !(l.split_whitespace().next() == Some(pattern.trim()) && l.contains("filter=lfs")))
        .collect();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    fs::write(&p, out)?;
    invalidate_cache();
    Ok(())
}

pub fn info(repo: &Repository, creds: &CredSet) -> AppResult<LfsInfo> {
    let enabled = repo_uses_lfs(repo);
    let patterns = if enabled { patterns(repo) } else { vec![] };
    let pending = if enabled { pending_pointers(repo)?.len() } else { 0 };
    let local_objects = store(repo).each_object().map(|v| v.len()).unwrap_or(0);
    let endpoint = if enabled {
        default_remote(repo)
            .and_then(|r| endpoint(repo, &r, creds).ok())
            .map(|e| e.display)
    } else {
        None
    };
    Ok(LfsInfo {
        enabled,
        patterns,
        pending_pointers: pending,
        local_objects,
        endpoint,
    })
}
