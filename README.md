# VibeGitty

A cross-platform Git desktop client (Windows, macOS, Linux) built with [Tauri 2](https://tauri.app),
Rust and React. The UI follows the GitKraken layout: repository tabs, a toolbar
(Fetch / Pull / Push / Branch / Merge / Stash / Pop / Tag / Remotes / LFS), a branch
tree on the left, the commit graph in the middle and the working-directory /
commit-detail panel on the right.

Everything git-related is **built in**: libgit2 is statically vendored, Git LFS is
implemented in-process, SSH uses libssh2, HTTPS uses rustls. No external `git`,
`git-lfs` or `ssh` executable is needed.

## Features

- Open, clone and initialize repositories; several repositories open at once (tabs).
- Commit graph over all branches, remotes and tags with lane layout, WIP row, branch /
  remote / tag pills, virtualized for large histories ("Load more" paging).
- Working directory: stage / unstage / discard per file, per selection (Ctrl/Shift
  click, Ctrl+A), per folder or all; flat list or folder tree (single-child folder
  chains are compacted); diffs (unstaged, staged, per commit) as unified hunks or a
  side-by-side view of the whole file; commit with summary +
  description, amend, Ctrl+Enter. Right-click untracked files or folders to add them
  or their extension to `.gitignore`.
- Branches: create, checkout, checkout remote branch (creates a tracking branch),
  rename, delete (with force fallback), set upstream, ahead/behind counts.
- Fetch (with prune), pull (merge or fast-forward only), push (set upstream, force),
  delete remote branches, push tags, manage remotes.
- Merge with conflict handling: conflicted files listed, take ours / theirs or edit and
  mark resolved, commit the merge, or abort. Cherry-pick, revert, reset (soft / mixed
  / hard), tags (lightweight and annotated), stashes (save / apply / pop / drop).
- Accounts:
  - **GitHub** OAuth device flow (no client secret) or a personal access token; works
    with GitHub Enterprise too.
  - **GitLab** (gitlab.com or self-hosted) OAuth 2.0 with PKCE + loopback redirect, or
    a personal access token.
  - **Gitea / Forgejo** OAuth (PKCE) or access token.
  - **Bitbucket** app password, and any other git server with username + password/token.
  - Tokens are stored in the OS keychain (Credential Manager / Keychain / Secret
    Service). Accounts are used automatically for HTTPS push/pull/fetch, LFS and for
    listing your repositories in the clone dialog.
- SSH remotes use ssh-agent (Pageant / OpenSSH agent) or `~/.ssh/id_ed25519`,
  `id_ecdsa`, `id_rsa`.
- **Git LFS built in**: `.gitattributes` patterns, pointer files, the local object
  store (`.git/lfs/objects`, compatible with git-lfs), the batch API and transfers.
  Staging an LFS-tracked file stores its content and commits a pointer; checkout /
  pull / clone download and restore content; push uploads the objects first (like the
  git-lfs pre-push hook). `git-lfs-authenticate` over SSH is supported. Large files
  in the changes panel get a size warning and a one-click "Track with LFS".
- Live refresh: a filesystem watcher picks up changes made by editors or other tools.

## Project layout

```
src/                 React + TypeScript frontend (Vite)
  components/        TabBar, Toolbar, LeftPanel, CommitGraph, RightPanel, DiffView, modals...
  lib/graph.ts       commit graph lane layout
  store/             zustand stores (repos, config, ui)
src-tauri/src/
  git/               libgit2 engine: log, status, staging, commit, branch, merge, diff, remote...
  lfs/               Git LFS: attributes, pointers, store, smudge/clean, batch transfers, ssh auth
  auth/              GitHub device flow, PKCE loopback flow, provider REST APIs
  commands.rs        Tauri command layer
  watcher.rs         filesystem watcher
src-tauri/tests/     integration tests for the git engine and LFS (libgit2 only)
```

## Building

Prerequisites: Rust (stable), Node.js 18+, and the platform requirements of Tauri 2
(<https://tauri.app/start/prerequisites/>).

- Windows: Visual Studio C++ build tools, WebView2 (bundled with Windows 10/11).
- macOS: Xcode command line tools. OpenSSL is needed for libssh2; either
  `brew install openssl@3` or build with `--features vendored-openssl`.
- Linux (Debian/Ubuntu):
  `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config`
  (`libdbus-1-dev` is used by the keychain integration; `libssl-dev` by libssh2. Use
  `--features vendored-openssl` to build OpenSSL from source instead.)

```bash
npm install
npm run dev                  # UI only in a browser, backed by src/devMock.ts (fake repo)
npm run tauri dev            # run in development mode
npm run tauri build          # produce installers/bundles for the current platform
# e.g. with vendored OpenSSL on Linux/macOS:
npm run tauri build -- --features vendored-openssl
```

### Portable (single-file) Windows build

`src-tauri/target/release/vibegitty.exe` produced by `npm run tauri build` is
self-contained (frontend assets, libgit2, libssh2, LFS and TLS are all compiled in);
it only needs the WebView2 runtime that ships with Windows 10/11. To run it as a
portable app, put a `VibeGittyData` folder (or an empty `portable.txt` file) next to the
exe: settings and tokens are then stored there instead of `%APPDATA%\VibeGitty` and the
Windows Credential Manager.

Run the engine tests:

```bash
cd src-tauri
cargo test --test ops
```

## Setting up OAuth sign-in

- **GitHub**: a client id for github.com is built into the app, so "Sign in with
  browser" works out of the box (device flow, no client secret). To ship your own,
  create an OAuth App at <https://github.com/settings/developers>, enable *Device
  Flow*, and build with the `VIBEGITTY_GITHUB_CLIENT_ID` environment variable set (or
  change `BUILTIN_GITHUB_CLIENT_ID` in `src-tauri/src/config.rs`). GitHub Enterprise
  servers need their own OAuth App; its id is entered in the sign-in dialog.
  Alternatively use a personal access token with the `repo` scope.
- **GitLab**: create an application (User Settings → Applications) with *Confidential*
  unchecked, redirect URI `http://127.0.0.1:47831/callback` (the port is configurable
  in Settings) and scopes `api read_user`. PKCE is used; no secret is needed.
- **Gitea / Forgejo**: create an OAuth2 application (public client) with the same
  redirect URI.

## Notes on the git engine

- Authentication for HTTPS remotes: the matching account token is used first; if none
  matches, an existing git credential helper (if any is configured) is tried. SSH host
  keys are accepted on first use.
- Pull is fetch + merge (or fast-forward only). Rebase is not implemented yet.
- Aborting a merge / cherry-pick / revert resets the working tree to HEAD.
- Diffs are capped at 6000 lines and 8 MB per file; LFS files show their pointer.

## GitHub sign-in

Two OAuth flows are supported for github.com and GitHub Enterprise:

- **Browser sign-in** (like GitKraken): the app opens GitHub's authorization page, you approve it, and GitHub sends the browser back to `http://127.0.0.1:47831/callback` (the port is configurable in Settings). GitHub requires the OAuth App's *client secret* for this flow, so it is only used when a secret is compiled in: put it in `src-tauri/github-client-secret.txt` (one line, never committed) or set `VIBEGITTY_GITHUB_CLIENT_SECRET` when building. The OAuth App's "Authorization callback URL" must be `http://127.0.0.1:47831/callback` (or `http://127.0.0.1/callback`).
- **Device flow**: used automatically when no secret is available. A one-time code is shown in the app and confirmed on github.com; the OAuth App must have "Device Flow" enabled.

GitHub Enterprise servers use their own OAuth App: enter its client id (and optionally the client secret) in the sign-in dialog.
