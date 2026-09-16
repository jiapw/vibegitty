//! Debug helper: `cargo run --example status_check -- <repo> [stage|unstage]`
//! Prints the working status as the engine sees it, optionally after staging
//! or unstaging everything, and lists suspicious entries.

use std::collections::BTreeMap;
use vibegitty_lib::git::{self, staging, status};

fn summarize(label: &str, st: &vibegitty_lib::git::types::WorkingStatus) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in &st.staged {
        *counts.entry(format!("staged/{}", e.status)).or_default() += 1;
    }
    for e in &st.unstaged {
        *counts.entry(format!("unstaged/{}", e.status)).or_default() += 1;
    }
    for e in &st.conflicted {
        *counts.entry("conflicted".into()).or_default() += 1;
    }
    println!("== {label}: {counts:?}");
    for e in st.unstaged.iter().filter(|e| e.status == "deleted").take(5) {
        println!("   unstaged deleted: {}", e.path);
    }
    for e in st.staged.iter().filter(|e| e.status == "deleted").take(5) {
        println!("   staged deleted: {}", e.path);
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("repo path");
    let op = args.next().unwrap_or_default();
    let repo = git::open(&path).expect("open");
    let st = status::working_status(&repo).expect("status");
    summarize("before", &st);
    match op.as_str() {
        "stage" => {
            let paths: Vec<String> = st.unstaged.iter().map(|e| e.path.clone()).collect();
            let t = std::time::Instant::now();
            staging::stage_paths(&repo, &paths).expect("stage");
            println!("staged {} paths in {:?}", paths.len(), t.elapsed());
        }
        "unstage" => {
            let paths: Vec<String> = st.staged.iter().map(|e| e.path.clone()).collect();
            let t = std::time::Instant::now();
            staging::unstage_paths(&repo, &paths).expect("unstage");
            println!("unstaged {} paths in {:?}", paths.len(), t.elapsed());
        }
        _ => return,
    }
    let after = status::working_status(&repo).expect("status");
    summarize("after", &after);
}
