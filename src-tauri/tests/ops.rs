//! Integration tests for the built-in git engine and LFS layer. Everything
//! runs against temporary repositories using libgit2 only (no git binary).

use vibegitty_lib::config::Settings;
use vibegitty_lib::git::creds::OpContext;
use vibegitty_lib::git::{self, branch, commit, diff, log, merge, refs, remote, repo as grepo, staging, stash, status, tags};
use vibegitty_lib::git::types::DiffTarget;
use vibegitty_lib::lfs;
use vibegitty_lib::state::CredSet;
use std::fs;
use std::path::{Path, PathBuf};

fn settings() -> Settings {
    Settings {
        author_name: "Tester".into(),
        author_email: "tester@example.com".into(),
        ..Default::default()
    }
}

fn tmp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("vibegitty-test-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
}

/// Read a text file with line endings normalized (core.autocrlf may be on).
fn read(dir: &Path, rel: &str) -> String {
    fs::read_to_string(dir.join(rel)).unwrap().replace("\r\n", "\n")
}

fn ctx() -> OpContext {
    OpContext::silent("test", "test", CredSet::default())
}

/// Stage everything that is unstaged and commit.
fn commit_all(repo: &git2::Repository, msg: &str) -> String {
    let st = status::working_status(repo).unwrap();
    let paths: Vec<String> = st.unstaged.iter().map(|e| e.path.clone()).collect();
    if !paths.is_empty() {
        staging::stage_paths(repo, &paths).unwrap();
    }
    commit::commit(repo, &settings(), msg, false).unwrap()
}

#[test]
fn init_status_stage_commit_log() {
    let dir = tmp("basic");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    assert!(info.head.unborn);
    let repo = git::open(&info.path).unwrap();

    write(&dir, "README.md", "hello\n");
    write(&dir, "src/main.rs", "fn main() {}\n");
    let st = status::working_status(&repo).unwrap();
    assert_eq!(st.unstaged.len(), 2);
    assert_eq!(st.unstaged[0].status, "untracked");
    assert!(st.staged.is_empty());

    staging::stage_paths(&repo, &["README.md".into()]).unwrap();
    let st = status::working_status(&repo).unwrap();
    assert_eq!(st.staged.len(), 1);
    assert_eq!(st.staged[0].status, "added");
    assert_eq!(st.unstaged.len(), 1);

    // nothing staged for the second file yet -> unstage/restage round trip
    staging::unstage_paths(&repo, &["README.md".into()]).unwrap();
    assert!(status::working_status(&repo).unwrap().staged.is_empty());

    let oid = commit_all(&repo, "Initial commit");
    assert_eq!(oid.len(), 40);
    let info = grepo::info(&repo).unwrap();
    assert!(!info.head.unborn);
    assert_eq!(info.head.oid.as_deref(), Some(oid.as_str()));

    let page = log::get_log(&repo, 0, 50).unwrap();
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].summary, "Initial commit");
    assert!(page.commits[0].parents.is_empty());

    // modify + diff
    write(&dir, "README.md", "hello\nworld\n");
    let st = status::working_status(&repo).unwrap();
    assert_eq!(st.unstaged.len(), 1);
    assert_eq!(st.unstaged[0].status, "modified");
    let d = diff::get_diff(
        &repo,
        &DiffTarget {
            kind: "unstaged".into(),
            oid: None,
            path: "README.md".into(),
            old_path: None,
            full: false,
        },
    )
    .unwrap();
    assert_eq!(d.additions, 1);
    assert_eq!(d.deletions, 0);
    assert_eq!(d.hunks.len(), 1);

    // discard restores the file
    staging::discard_paths(&repo, &["README.md".into()]).unwrap();
    assert_eq!(read(&dir, "README.md"), "hello\n");
    assert!(status::working_status(&repo).unwrap().unstaged.is_empty());

    // amend
    write(&dir, "extra.txt", "x\n");
    staging::stage_paths(&repo, &["extra.txt".into()]).unwrap();
    let amended = commit::commit(&repo, &settings(), "Initial commit (amended)", true).unwrap();
    assert_ne!(amended, oid);
    let page = log::get_log(&repo, 0, 50).unwrap();
    assert_eq!(page.commits.len(), 1);
    let detail = diff::commit_detail(&repo, &amended).unwrap();
    assert_eq!(detail.files.len(), 3);
}

#[test]
fn branches_merge_fast_forward_and_conflicts() {
    let dir = tmp("merge");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    let repo = git::open(&info.path).unwrap();
    write(&dir, "a.txt", "line1\nline2\nline3\n");
    commit_all(&repo, "base");
    let main_branch = grepo::info(&repo).unwrap().head.branch.unwrap();

    // feature branch, one commit ahead -> fast-forward merge
    branch::create_branch(&repo, "feature", None, true).unwrap();
    assert_eq!(grepo::info(&repo).unwrap().head.branch.as_deref(), Some("feature"));
    write(&dir, "b.txt", "feature\n");
    let feat_oid = commit_all(&repo, "feature work");
    branch::checkout_branch(&repo, &main_branch).unwrap();
    assert!(!dir.join("b.txt").exists());
    let r = merge::merge_branch(&repo, &settings(), "feature", false).unwrap();
    assert_eq!(r.kind, "fast_forward");
    assert_eq!(grepo::info(&repo).unwrap().head.oid.unwrap(), feat_oid);
    assert!(dir.join("b.txt").exists());

    // diverge on the same line -> conflict
    write(&dir, "a.txt", "line1\nMAIN\nline3\n");
    commit_all(&repo, "main edit");
    branch::checkout_branch(&repo, "feature").unwrap();
    write(&dir, "a.txt", "line1\nFEATURE\nline3\n");
    commit_all(&repo, "feature edit");
    branch::checkout_branch(&repo, &main_branch).unwrap();
    let r = merge::merge_branch(&repo, &settings(), "feature", false).unwrap();
    assert_eq!(r.kind, "conflicts");
    assert_eq!(r.conflicts, vec!["a.txt".to_string()]);
    let st = status::working_status(&repo).unwrap();
    assert_eq!(st.state, "merge");
    assert_eq!(st.conflicted.len(), 1);
    assert_eq!(st.merge_heads.len(), 1);
    assert!(commit::commit(&repo, &settings(), "should fail", false).is_err());

    // conflict view + resolve by taking theirs
    let d = diff::get_diff(
        &repo,
        &DiffTarget {
            kind: "conflict".into(),
            oid: None,
            path: "a.txt".into(),
            old_path: None,
            full: false,
        },
    )
    .unwrap();
    assert!(d.hunks[0].lines.iter().any(|l| l.content.starts_with("<<<<<<<")));
    merge::resolve_conflict(&repo, "a.txt", "theirs").unwrap();
    assert_eq!(read(&dir, "a.txt"), "line1\nFEATURE\nline3\n");
    let st = status::working_status(&repo).unwrap();
    assert!(st.conflicted.is_empty());
    assert_eq!(st.state, "merge");
    let merge_oid = commit::commit(&repo, &settings(), "Merge feature", false).unwrap();
    assert_eq!(status::working_status(&repo).unwrap().state, "clean");
    let page = log::get_log(&repo, 0, 50).unwrap();
    let top = &page.commits[0];
    assert_eq!(top.oid, merge_oid);
    assert_eq!(top.parents.len(), 2);

    // refs: local branches, head flag, tag
    tags::create(&repo, &settings(), "v1", None, Some("release")).unwrap();
    let all = refs::list_refs(&repo).unwrap();
    assert!(all.iter().any(|r| r.kind == "local" && r.name == "feature"));
    assert!(all.iter().any(|r| r.kind == "local" && r.name == main_branch && r.is_head));
    let tag = all.iter().find(|r| r.kind == "tag").unwrap();
    assert_eq!(tag.name, "v1");
    assert_eq!(tag.oid, merge_oid);
    assert_eq!(tag.message.as_deref(), Some("release"));

    // delete merged branch works without force; rename
    branch::delete_branch(&repo, "feature", false).unwrap();
    assert!(!refs::list_refs(&repo).unwrap().iter().any(|r| r.name == "feature"));
    branch::create_branch(&repo, "wip", Some(&merge_oid), false).unwrap();
    branch::rename_branch(&repo, "wip", "wip2").unwrap();
    assert!(refs::list_refs(&repo).unwrap().iter().any(|r| r.name == "wip2"));

    // abort a conflicting merge
    write(&dir, "a.txt", "line1\nAGAIN\nline3\n");
    commit_all(&repo, "main again");
    branch::checkout_branch(&repo, "wip2").unwrap();
    write(&dir, "a.txt", "line1\nOTHER\nline3\n");
    commit_all(&repo, "wip2 edit");
    branch::checkout_branch(&repo, &main_branch).unwrap();
    let r = merge::merge_branch(&repo, &settings(), "wip2", false).unwrap();
    assert_eq!(r.kind, "conflicts");
    merge::abort_operation(&repo).unwrap();
    assert_eq!(status::working_status(&repo).unwrap().state, "clean");
    assert_eq!(read(&dir, "a.txt"), "line1\nAGAIN\nline3\n");

    // cherry-pick + revert + reset
    let wip2_tip = refs::list_refs(&repo).unwrap().iter().find(|r| r.name == "wip2").unwrap().oid.clone();
    let r = merge::cherry_pick(&repo, &settings(), &wip2_tip).unwrap();
    assert_eq!(r.kind, "conflicts");
    merge::abort_operation(&repo).unwrap();
    let head_before = grepo::info(&repo).unwrap().head.oid.unwrap();
    write(&dir, "c.txt", "c\n");
    let c_oid = commit_all(&repo, "add c");
    let r = merge::revert(&repo, &settings(), &c_oid).unwrap();
    assert_eq!(r.kind, "merged");
    assert!(!dir.join("c.txt").exists());
    merge::reset(&repo, &head_before, "hard").unwrap();
    assert_eq!(grepo::info(&repo).unwrap().head.oid.unwrap(), head_before);
}

#[test]
fn stash_roundtrip() {
    let dir = tmp("stash");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    let mut repo = git::open(&info.path).unwrap();
    write(&dir, "f.txt", "one\n");
    commit_all(&repo, "base");
    write(&dir, "f.txt", "two\n");
    write(&dir, "new.txt", "n\n");
    stash::save(&mut repo, &settings(), Some("my stash"), true).unwrap();
    assert!(status::working_status(&repo).unwrap().unstaged.is_empty());
    assert_eq!(read(&dir, "f.txt"), "one\n");
    let list = stash::list(&mut repo).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].message.contains("my stash"));
    stash::apply(&mut repo, 0, true).unwrap();
    assert_eq!(read(&dir, "f.txt"), "two\n");
    assert!(dir.join("new.txt").exists());
    assert!(stash::list(&mut repo).unwrap().is_empty());
}

#[test]
fn lfs_stage_smudge_and_push_objects() {
    let dir = tmp("lfs");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    let repo = git::open(&info.path).unwrap();
    write(&dir, "README.md", "readme\n");
    commit_all(&repo, "base");
    assert!(!lfs::repo_uses_lfs(&repo));

    lfs::track(&repo, "*.bin").unwrap();
    assert!(lfs::repo_uses_lfs(&repo));
    assert_eq!(lfs::patterns(&repo), vec!["*.bin".to_string()]);
    let data: Vec<u8> = (0..50_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    fs::write(dir.join("model.bin"), &data).unwrap();

    let st = status::working_status(&repo).unwrap();
    let entry = st.unstaged.iter().find(|e| e.path == "model.bin").unwrap();
    assert!(entry.is_lfs);
    assert_eq!(entry.size, data.len() as u64);

    staging::stage_paths(&repo, &[".gitattributes".into(), "model.bin".into()]).unwrap();
    let st = status::working_status(&repo).unwrap();
    assert!(st.unstaged.is_empty(), "LFS file must not look modified after staging: {:?}", st.unstaged);
    let staged = st.staged.iter().find(|e| e.path == "model.bin").unwrap();
    assert!(staged.is_lfs);

    // the index holds a pointer blob, the store holds the content
    let index = repo.index().unwrap();
    let ie = index.get_path(Path::new("model.bin"), 0).unwrap();
    let blob = repo.find_blob(ie.id).unwrap();
    let pointer = lfs::parse_pointer(blob.content()).expect("index blob is an LFS pointer");
    assert_eq!(pointer.size, data.len() as u64);
    assert!(lfs::store(&repo).contains_with_size(pointer.oid, pointer.size));
    // staged diff shows the pointer
    let d = diff::get_diff(
        &repo,
        &DiffTarget {
            kind: "staged".into(),
            oid: None,
            path: "model.bin".into(),
            old_path: None,
            full: false,
        },
    )
    .unwrap();
    assert!(d.is_lfs);
    assert!(d.hunks[0].lines.iter().any(|l| l.content.starts_with("oid sha256:")));

    let oid = commit::commit(&repo, &settings(), "add model", false).unwrap();
    assert!(status::working_status(&repo).unwrap().staged.is_empty());
    assert!(status::working_status(&repo).unwrap().unstaged.is_empty());

    // objects to push: no remote refs -> everything reachable
    let objs = lfs::objects_for_push(&repo, "origin", git2::Oid::from_str(&oid).unwrap()).unwrap();
    assert_eq!(objs.len(), 1);
    assert_eq!(objs[0].oid, pointer.oid);

    // simulate a fresh checkout: libgit2 writes the pointer blob into the
    // working tree (no smudge filter) and records its stat data in the index
    fs::remove_file(dir.join("model.bin")).unwrap();
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force();
    repo.checkout_head(Some(&mut cb)).unwrap();
    assert_eq!(fs::read(dir.join("model.bin")).unwrap(), pointer.encode().as_bytes());
    assert_eq!(lfs::pending_pointers(&repo).unwrap().len(), 1);
    // a pointer written behind libgit2's back is only found by the thorough scan
    fs::write(dir.join("model.bin"), pointer.encode()).unwrap();
    assert_eq!(lfs::pending_pointers_thorough(&repo).unwrap().len(), 1);
    let (smudged, missing) = lfs::smudge_all_local(&repo).unwrap();
    assert_eq!((smudged, missing), (1, 0));
    assert_eq!(fs::read(dir.join("model.bin")).unwrap(), data);
    let st = status::working_status(&repo).unwrap();
    assert!(st.unstaged.is_empty(), "smudged file must be clean: {:?}", st.unstaged);

    // a real modification is detected
    let mut data2 = data.clone();
    data2.push(1);
    fs::write(dir.join("model.bin"), &data2).unwrap();
    let st = status::working_status(&repo).unwrap();
    assert_eq!(st.unstaged.len(), 1);
    assert_eq!(st.unstaged[0].status, "modified");
    assert!(st.unstaged[0].is_lfs);
    // discard restores the smudged original from the local store
    staging::discard_paths(&repo, &["model.bin".into()]).unwrap();
    assert_eq!(fs::read(dir.join("model.bin")).unwrap(), data);

    let lfs_info = lfs::info(&repo, &CredSet::default()).unwrap();
    assert!(lfs_info.enabled);
    assert_eq!(lfs_info.local_objects, 1);
    assert_eq!(lfs_info.pending_pointers, 0);
}

#[test]
fn remote_push_fetch_pull_via_local_bare() {
    let work1 = tmp("remote-a");
    let bare = tmp("remote-bare");
    let work2 = tmp("remote-b");
    git2::Repository::init_bare(&bare).unwrap();
    let bare_url = bare.to_string_lossy().replace('\\', "/");

    let info = grepo::init(work1.to_str().unwrap()).unwrap();
    let repo1 = git::open(&info.path).unwrap();
    write(&work1, "f.txt", "v1\n");
    let c1 = commit_all(&repo1, "first");
    grepo::add_remote(&repo1, "origin", &bare_url).unwrap();
    assert_eq!(grepo::remotes(&repo1).unwrap()[0].name, "origin");

    let target = remote::resolve_push_target(&repo1, None, None).unwrap();
    assert_eq!(target.remote, "origin");
    remote::push(&ctx(), &repo1, &target, false, true).unwrap();
    let head = grepo::info(&repo1).unwrap().head;
    assert_eq!(head.upstream.as_deref(), Some(format!("origin/{}", target.branch).as_str()));
    assert_eq!((head.ahead, head.behind), (0, 0));

    // clone into a second working copy, commit there, push
    let cloned = remote::clone(&ctx(), &bare_url, &work2).unwrap();
    let repo2 = git::open(cloned.workdir().unwrap().to_str().unwrap()).unwrap();
    assert_eq!(grepo::info(&repo2).unwrap().head.oid.as_deref(), Some(c1.as_str()));
    write(&work2, "f.txt", "v2\n");
    let c2 = commit_all(&repo2, "second");
    let t2 = remote::resolve_push_target(&repo2, None, None).unwrap();
    remote::push(&ctx(), &repo2, &t2, false, false).unwrap();

    // fetch in repo1: behind by one, then pull fast-forwards
    remote::fetch(&ctx(), &repo1, Some("origin"), true).unwrap();
    let head = grepo::info(&repo1).unwrap().head;
    assert_eq!((head.ahead, head.behind), (0, 1));
    let pulled = remote::pull(&ctx(), &repo1, &settings(), true).unwrap();
    assert_eq!(pulled.merge.kind, "fast_forward");
    assert_eq!(grepo::info(&repo1).unwrap().head.oid.as_deref(), Some(c2.as_str()));
    assert_eq!(read(&work1, "f.txt"), "v2\n");

    // non-fast-forward push is rejected, force push succeeds
    write(&work1, "g.txt", "g\n");
    commit_all(&repo1, "third (repo1)");
    write(&work2, "h.txt", "h\n");
    commit_all(&repo2, "third (repo2)");
    remote::push(&ctx(), &repo2, &t2, false, false).unwrap();
    let t1 = remote::resolve_push_target(&repo1, None, None).unwrap();
    let err = remote::push(&ctx(), &repo1, &t1, false, false).unwrap_err().to_string();
    assert!(err.to_lowercase().contains("rejected") || err.to_lowercase().contains("fast-forward"), "{err}");
    remote::push(&ctx(), &repo1, &t1, true, false).unwrap();

    // remote branch checkout + delete on remote + tag push
    branch::create_branch(&repo1, "topic", None, true).unwrap();
    write(&work1, "t.txt", "t\n");
    commit_all(&repo1, "topic commit");
    let tt = remote::resolve_push_target(&repo1, Some("origin"), Some("topic")).unwrap();
    remote::push(&ctx(), &repo1, &tt, false, true).unwrap();
    remote::fetch(&ctx(), &repo2, Some("origin"), false).unwrap();
    let local = branch::checkout_remote_branch(&repo2, "origin/topic", None).unwrap();
    assert_eq!(local, "topic");
    assert!(work2.join("t.txt").exists());
    tags::create(&repo1, &settings(), "v0.1", None, None).unwrap();
    remote::push_tag(&ctx(), &repo1, "origin", "v0.1").unwrap();
    remote::fetch(&ctx(), &repo2, Some("origin"), false).unwrap();
    assert!(refs::list_refs(&repo2).unwrap().iter().any(|r| r.kind == "tag" && r.name == "v0.1"));
    remote::delete_remote_branch(&ctx(), &repo1, "origin", "topic").unwrap();
    assert!(!refs::list_refs(&repo1).unwrap().iter().any(|r| r.name == "origin/topic"));
}

#[test]
fn untracked_entries_report_tracked_parent() {
    let dir = tmp("tracked-parent");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    let repo = git::open(&info.path).unwrap();
    write(&dir, "README.md", "r\n");
    write(&dir, "a/b/tracked.txt", "t\n");
    commit_all(&repo, "base");
    write(&dir, "a/b/c/new.txt", "n\n");
    write(&dir, "a/other/deep/new2.txt", "n\n");
    write(&dir, "x/y/new3.txt", "n\n");
    let st = status::working_status(&repo).unwrap();
    let tp = |p: &str| st.unstaged.iter().find(|e| e.path == p).unwrap().tracked_parent.clone();
    assert_eq!(tp("a/b/c/new.txt").as_deref(), Some("a/b"));
    assert_eq!(tp("a/other/deep/new2.txt").as_deref(), Some("a"));
    assert_eq!(tp("x/y/new3.txt"), None);
}

#[test]
fn renamed_entries_stage_and_unstage_both_paths() {
    let dir = tmp("rename");
    let info = grepo::init(dir.to_str().unwrap()).unwrap();
    let repo = git::open(&info.path).unwrap();
    let body = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n";
    for i in 0..3 {
        write(&dir, &format!("old/dir/file{i}.txt"), &format!("{body}file {i}\n"));
    }
    commit_all(&repo, "base");
    // move the whole directory
    for i in 0..3 {
        write(&dir, &format!("new/dir/file{i}.txt"), &format!("{body}file {i}\n"));
        fs::remove_file(dir.join(format!("old/dir/file{i}.txt"))).unwrap();
    }
    let st = status::working_status(&repo).unwrap();
    let renamed: Vec<_> = st.unstaged.iter().filter(|e| e.status == "renamed").collect();
    assert_eq!(renamed.len(), 3, "libgit2 should pair the moves as renames: {:?}", st.unstaged);
    assert!(renamed.iter().all(|e| e.old_path.as_deref().map(|p| p.starts_with("old/")).unwrap_or(false)));

    // stage only the new paths, as the UI does; the old paths must be expanded in
    let new_paths: Vec<String> = renamed.iter().map(|e| e.path.clone()).collect();
    let expanded = staging::expand_renames(&repo, &new_paths, false).unwrap();
    assert_eq!(expanded.len(), 6);
    staging::stage_paths(&repo, &expanded).unwrap();
    let st = status::working_status(&repo).unwrap();
    assert!(st.unstaged.is_empty(), "no phantom deletions after staging a move: {:?}", st.unstaged);
    assert_eq!(st.staged.iter().filter(|e| e.status == "renamed").count(), 3);

    // and back
    let staged_paths: Vec<String> = st.staged.iter().map(|e| e.path.clone()).collect();
    let expanded = staging::expand_renames(&repo, &staged_paths, true).unwrap();
    assert_eq!(expanded.len(), 6);
    staging::unstage_paths(&repo, &expanded).unwrap();
    let st = status::working_status(&repo).unwrap();
    assert!(st.staged.is_empty(), "no phantom deletions after unstaging a move: {:?}", st.staged);
    assert_eq!(st.unstaged.iter().filter(|e| e.status == "renamed").count(), 3);
}

#[test]
fn url_host_parsing() {
    assert_eq!(remote::url_host("https://github.com/a/b.git").as_deref(), Some("github.com"));
    assert_eq!(remote::url_host("https://gitlab.example.com:8443/a/b.git").as_deref(), Some("gitlab.example.com:8443"));
    assert_eq!(remote::url_host("git@github.com:a/b.git").as_deref(), Some("github.com"));
    assert_eq!(remote::url_host("ssh://git@bitbucket.org/a/b.git").as_deref(), Some("bitbucket.org"));
    assert_eq!(remote::url_host("C:/repos/local"), None);
}
