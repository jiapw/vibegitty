use super::status::delta_status_str;
use super::types::*;
use super::*;
use git2::{Commit, Delta, Diff, DiffFindOptions, DiffOptions, Oid, Repository};
use std::cell::RefCell;
use std::path::Path;

const MAX_DIFF_LINES: usize = 6000;
/// Side-by-side views carry the whole file, so allow much more.
const MAX_FULL_DIFF_LINES: usize = 40_000;
const MAX_DIFF_BYTES: i64 = 8 * 1024 * 1024;
/// "All of the file" as a context size.
const FULL_CONTEXT: u32 = 10_000_000;

fn base_opts(full: bool) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.context_lines(if full { FULL_CONTEXT } else { 3 }).max_size(MAX_DIFF_BYTES);
    opts
}

fn max_lines(full: bool) -> usize {
    if full {
        MAX_FULL_DIFF_LINES
    } else {
        MAX_DIFF_LINES
    }
}

fn commit_diff<'r>(
    repo: &'r Repository,
    commit: &Commit,
    path: Option<&str>,
    old_path: Option<&str>,
    full: bool,
) -> AppResult<Diff<'r>> {
    let tree = commit.tree()?;
    let parent_tree = match commit.parent(0) {
        Ok(p) => Some(p.tree()?),
        Err(_) => None,
    };
    let mut opts = base_opts(full);
    if let Some(p) = path {
        opts.pathspec(p);
    }
    if let Some(op) = old_path {
        opts.pathspec(op);
    }
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))?;
    Ok(diff)
}

pub fn commit_detail(repo: &Repository, oid: &str) -> AppResult<CommitDetail> {
    let commit = repo.find_commit(Oid::from_str(oid)?)?;
    let diff = commit_diff(repo, &commit, None, None, false)?;
    let files: RefCell<Vec<CommitFile>> = RefCell::new(Vec::new());

    let mut file_cb = |d: git2::DiffDelta<'_>, _p: f32| -> bool {
        let old = if matches!(d.status(), Delta::Renamed | Delta::Copied) {
            Some(path_str(d.old_file().path()))
        } else {
            None
        };
        files.borrow_mut().push(CommitFile {
            path: path_str(d.new_file().path()),
            old_path: old,
            status: delta_status_str(d.status()).into(),
            additions: 0,
            deletions: 0,
            is_binary: false,
        });
        true
    };
    let mut binary_cb = |_d: git2::DiffDelta<'_>, _b: git2::DiffBinary<'_>| -> bool {
        if let Some(f) = files.borrow_mut().last_mut() {
            f.is_binary = true;
        }
        true
    };
    let mut line_cb = |_d: git2::DiffDelta<'_>, _h: Option<git2::DiffHunk<'_>>, l: git2::DiffLine<'_>| -> bool {
        let mut fs = files.borrow_mut();
        if let Some(f) = fs.last_mut() {
            match l.origin() {
                '+' => f.additions += 1,
                '-' => f.deletions += 1,
                _ => {}
            }
        }
        true
    };
    diff.foreach(&mut file_cb, Some(&mut binary_cb), None, Some(&mut line_cb))?;
    let files = files.into_inner();
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Ok(CommitDetail {
        commit: log::commit_info(&commit),
        files,
        additions,
        deletions,
    })
}

fn build_file_diff(diff: &Diff, path: &str, limit: usize) -> AppResult<FileDiff> {
    let out = RefCell::new(FileDiff {
        path: path.to_string(),
        ..Default::default()
    });
    let line_count = RefCell::new(0usize);

    let mut file_cb = |d: git2::DiffDelta<'_>, _p: f32| -> bool {
        let mut o = out.borrow_mut();
        o.status = delta_status_str(d.status()).to_string();
        o.old_path = if matches!(d.status(), Delta::Renamed | Delta::Copied) {
            Some(path_str(d.old_file().path()))
        } else {
            None
        };
        if d.new_file().path().is_some() {
            o.path = path_str(d.new_file().path());
        }
        true
    };
    let mut binary_cb = |_d: git2::DiffDelta<'_>, _b: git2::DiffBinary<'_>| -> bool {
        out.borrow_mut().is_binary = true;
        true
    };
    let mut hunk_cb = |_d: git2::DiffDelta<'_>, h: git2::DiffHunk<'_>| -> bool {
        if *line_count.borrow() >= limit {
            out.borrow_mut().truncated = true;
            return false;
        }
        out.borrow_mut().hunks.push(DiffHunk {
            header: String::from_utf8_lossy(h.header()).trim_end().to_string(),
            old_start: h.old_start(),
            old_lines: h.old_lines(),
            new_start: h.new_start(),
            new_lines: h.new_lines(),
            lines: Vec::new(),
        });
        true
    };
    let mut line_cb = |_d: git2::DiffDelta<'_>, _h: Option<git2::DiffHunk<'_>>, l: git2::DiffLine<'_>| -> bool {
        let kind = match l.origin() {
            '+' => "add",
            '-' => "del",
            ' ' => "context",
            _ => return true,
        };
        let mut o = out.borrow_mut();
        match kind {
            "add" => o.additions += 1,
            "del" => o.deletions += 1,
            _ => {}
        }
        let mut lc = line_count.borrow_mut();
        *lc += 1;
        if *lc > limit {
            o.truncated = true;
            return false;
        }
        let content = String::from_utf8_lossy(l.content())
            .trim_end_matches(['\n', '\r'])
            .to_string();
        if let Some(h) = o.hunks.last_mut() {
            h.lines.push(DiffLine {
                kind: kind.into(),
                old_lineno: l.old_lineno(),
                new_lineno: l.new_lineno(),
                content,
            });
        }
        true
    };
    let r = diff.foreach(&mut file_cb, Some(&mut binary_cb), Some(&mut hunk_cb), Some(&mut line_cb));
    if let Err(e) = r {
        if !out.borrow().truncated {
            return Err(e.into());
        }
    }
    let mut fd = out.into_inner();
    if fd.truncated {
        fd.note = Some(format!("Diff truncated after {limit} lines"));
    }
    Ok(fd)
}

fn synthetic_diff(path: &str, old: Option<String>, new: Option<String>, note: &str) -> FileDiff {
    let mut lines = Vec::new();
    let (mut adds, mut dels) = (0u32, 0u32);
    if let Some(o) = &old {
        for (i, l) in o.lines().enumerate() {
            lines.push(DiffLine {
                kind: "del".into(),
                old_lineno: Some(i as u32 + 1),
                new_lineno: None,
                content: l.to_string(),
            });
            dels += 1;
        }
    }
    if let Some(n) = &new {
        for (i, l) in n.lines().enumerate() {
            lines.push(DiffLine {
                kind: "add".into(),
                old_lineno: None,
                new_lineno: Some(i as u32 + 1),
                content: l.to_string(),
            });
            adds += 1;
        }
    }
    let status = match (&old, &new) {
        (None, Some(_)) => "added",
        (Some(_), None) => "deleted",
        _ => "modified",
    };
    let hunks = if lines.is_empty() {
        vec![]
    } else {
        vec![DiffHunk {
            header: format!("@@ -1,{dels} +1,{adds} @@"),
            old_start: 1,
            old_lines: dels,
            new_start: 1,
            new_lines: adds,
            lines,
        }]
    };
    FileDiff {
        path: path.to_string(),
        old_path: None,
        status: status.into(),
        is_binary: false,
        is_lfs: true,
        hunks,
        additions: adds as usize,
        deletions: dels as usize,
        truncated: false,
        note: Some(note.to_string()),
    }
}

fn index_blob_text(repo: &Repository, path: &str) -> Option<String> {
    let index = repo.index().ok()?;
    let e = index.get_path(Path::new(path), 0)?;
    let blob = repo.find_blob(e.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

fn head_blob_text(repo: &Repository, path: &str) -> Option<String> {
    let tree = repo.head().ok()?.peel_to_tree().ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let obj = entry.to_object(repo).ok()?;
    let blob = obj.as_blob()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

pub fn get_diff(repo: &Repository, target: &DiffTarget) -> AppResult<FileDiff> {
    let lfs_on = crate::lfs::repo_uses_lfs(repo);
    let path = target.path.as_str();
    let full = target.full;
    let limit = max_lines(full);
    match target.kind.as_str() {
        "commit" => {
            let oid = target.oid.as_deref().ok_or("missing commit id")?;
            let commit = repo.find_commit(Oid::from_str(oid)?)?;
            let diff = commit_diff(repo, &commit, Some(path), target.old_path.as_deref(), full)?;
            let mut fd = build_file_diff(&diff, path, limit)?;
            if lfs_on && fd.hunks.iter().any(|h| h.lines.iter().any(|l| l.content.starts_with("version https://git-lfs"))) {
                fd.is_lfs = true;
                fd.note = Some("Git LFS pointer".into());
            }
            Ok(fd)
        }
        "staged" => {
            if lfs_on && crate::lfs::is_lfs_path(repo, path) {
                let old = head_blob_text(repo, path);
                let new = index_blob_text(repo, path);
                return Ok(synthetic_diff(path, old, new, "Git LFS object (pointer shown)"));
            }
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let mut opts = base_opts(full);
            opts.pathspec(path);
            if let Some(op) = &target.old_path {
                opts.pathspec(op);
            }
            let mut diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?;
            let mut find = DiffFindOptions::new();
            find.renames(true);
            diff.find_similar(Some(&mut find))?;
            build_file_diff(&diff, path, limit)
        }
        "unstaged" => {
            if lfs_on && crate::lfs::is_lfs_path(repo, path) {
                let old = index_blob_text(repo, path);
                let abs = workdir(repo)?.join(path);
                let new = if abs.is_file() {
                    Some(crate::lfs::pointer_text_for_file(&abs)?)
                } else {
                    None
                };
                let note = if old == new {
                    "Git LFS object unchanged"
                } else {
                    "Git LFS object (pointer shown)"
                };
                return Ok(synthetic_diff(path, old, new, note));
            }
            let mut opts = base_opts(full);
            opts.pathspec(path)
                .include_untracked(true)
                .show_untracked_content(true)
                .recurse_untracked_dirs(true);
            let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
            build_file_diff(&diff, path, limit)
        }
        "conflict" => {
            let abs = workdir(repo)?.join(path);
            let text = std::fs::read(&abs).unwrap_or_default();
            let text = String::from_utf8_lossy(&text).to_string();
            let lines: Vec<DiffLine> = text
                .lines()
                .take(MAX_FULL_DIFF_LINES)
                .enumerate()
                .map(|(i, l)| {
                    let kind = if l.starts_with("<<<<<<<") || l.starts_with("=======") || l.starts_with(">>>>>>>") {
                        "del"
                    } else {
                        "context"
                    };
                    DiffLine {
                        kind: kind.into(),
                        old_lineno: Some(i as u32 + 1),
                        new_lineno: Some(i as u32 + 1),
                        content: l.to_string(),
                    }
                })
                .collect();
            let n = lines.len() as u32;
            Ok(FileDiff {
                path: path.to_string(),
                old_path: None,
                status: "conflicted".into(),
                is_binary: false,
                is_lfs: false,
                hunks: vec![DiffHunk {
                    header: format!("@@ -1,{n} +1,{n} @@ conflicted file"),
                    old_start: 1,
                    old_lines: n,
                    new_start: 1,
                    new_lines: n,
                    lines,
                }],
                additions: 0,
                deletions: 0,
                truncated: false,
                note: Some("Conflict markers are highlighted. Resolve in your editor, then mark as resolved.".into()),
            })
        }
        other => crate::error::err(format!("unknown diff kind '{other}'")),
    }
}
