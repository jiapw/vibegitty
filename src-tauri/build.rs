fn main() {
    // Optional client secret for GitHub's browser login: either the
    // VIBEGITTY_GITHUB_CLIENT_SECRET environment variable or a one-line
    // `github-client-secret.txt` next to Cargo.toml (kept out of the sources).
    println!("cargo:rerun-if-changed=github-client-secret.txt");
    println!("cargo:rerun-if-env-changed=VIBEGITTY_GITHUB_CLIENT_SECRET");
    let from_env = std::env::var("VIBEGITTY_GITHUB_CLIENT_SECRET")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !from_env {
        if let Ok(s) = std::fs::read_to_string("github-client-secret.txt") {
            let s = s.trim();
            if !s.is_empty() {
                println!("cargo:rustc-env=VIBEGITTY_GITHUB_CLIENT_SECRET={s}");
            }
        }
    }
    tauri_build::build()
}
