# VibeGitty

A cross-platform Git desktop client (Windows, macOS, Linux) built with [Tauri 2](https://tauri.app),
Rust and React. The UI follows the GitKraken layout: repository tabs, a toolbar
(Fetch / Pull / Push / Branch / Merge / Stash / Pop / Tag / Remotes / LFS), a branch
tree on the left, the commit graph in the middle and the working-directory /
commit-detail panel on the right.

Everything git-related is **built in**: libgit2 is statically vendored, Git LFS is
implemented in-process, SSH uses libssh2, HTTPS uses rustls. No external `git`,
`git-lfs` or `ssh` executable is needed.

Source: <https://github.com/jiapw/vibegitty>

![VibeGitty: commit graph with branch, tag and remote labels, the working-directory panel with unstaged and staged files, and the commit box](docs/screenshot.png)

## Download

Packages for every release are on the [Releases page](https://github.com/jiapw/vibegitty/releases):

- **Windows**: `VibeGitty-<version>-x64-portable.exe` (single file, nothing to install; put a
  `VibeGittyData` folder next to it to keep settings beside the exe), or the `.msi` /
  `-setup.exe` installers.
- **macOS**: universal `.dmg`. The build is not notarized yet: after copying the app run
  `xattr -cr /Applications/VibeGitty.app` once, or right-click → Open.
- **Linux**: `.AppImage`, `.deb` and `.rpm` (WebKitGTK 4.1 required).

## Features

- Open, clone and initialize repositories; several repositories open at once (tabs),
  an *Open recent* list in the "+" menu (entries can be removed), and the clone dialog
  remembers the last parent folder.
- Commit graph over all branches, remotes and tags with lane layout, a WIP row, HEAD
  marker, branch / remote / tag labels pointing at their commits, virtualized for large
  histories ("Load more" paging).
- Working directory: stage / unstage / discard per file, per selection (Ctrl/Shift
  click, Ctrl+A), per folder or all; flat list or folder tree (single-child folder
  chains are compacted); unstaged and staged lists in a resizable vertical split.
  Right-click untracked files or folders to add them, a parent folder or their
  extension to `.gitignore`; every file row (working directory and commit details) can
  be shown in Explorer / Finder / the file manager. Commit with a single-line summary +
  description, amend, Ctrl+Enter.
- Diff view (unstaged, staged, conflicts, per commit): unified hunks or a side-by-side
  view of the whole file, soft wrap on/off, syntax highlighting for 340+ languages
  (Shiki / TextMate grammars, picked by file name, loaded on demand, dark and light
  themes), character-level highlighting inside changed lines, change marks on the
  scrollbar, previous / next change buttons, and the view opens at the first change. In
  side-by-side mode without wrapping each side clips and scrolls long lines on its own
  while both sides stay aligned and in sync.
- Branches: create, checkout, checkout remote branch (creates a tracking branch),
  rename, delete (with force fallback), set upstream, ahead/behind counts.
- Fetch (with prune), pull (merge or fast-forward only), push (set upstream, force),
  delete remote branches, push tags, manage remotes.
- Merge and rebase (rebase onto any branch, tag or commit; pull with rebase) with
  conflict handling: when a pull, merge, rebase, cherry-pick or revert stops on
  conflicts the first conflicted file opens in a manual-merge view that shows each
  conflict as its two sides with *keep ours / theirs / both* buttons, plus whole-file
  take ours / theirs, mark resolved, next / previous conflicted file, and abort or
  commit / continue right there. Cherry-pick, revert, reset (soft / mixed / hard), tags
  (lightweight and annotated), stashes (save / apply / pop / drop).
- Accounts (see [Sign-in setup](#sign-in-setup)):
  - **GitHub**: sign in with the browser (OAuth web flow, like GitKraken), device flow
    as a fallback, or a personal access token; GitHub Enterprise supported.
  - **GitLab** (gitlab.com or self-hosted): OAuth 2.0 with PKCE + loopback redirect, or
    a personal access token.
  - **Gitea / Forgejo**: OAuth (PKCE) or access token.
  - **Bitbucket**: app password; any other git server with username + password/token.
  - Tokens live in the OS keychain (Credential Manager / Keychain / Secret Service).
    Accounts are used for HTTPS push/pull/fetch, LFS transfers and for listing your
    repositories in the clone dialog. A rejected token is reported clearly with a
    *Sign in again* shortcut; *Sign in again* on an account reuses the current token when
    it still works.
- SSH remotes use ssh-agent (Pageant / OpenSSH agent) or `~/.ssh/id_ed25519`,
  `id_ecdsa`, `id_rsa`.
- **Git LFS built in**: `.gitattributes` patterns, pointer files, the local object
  store (`.git/lfs/objects`, compatible with git-lfs), the batch API and transfers.
  Staging an LFS-tracked file stores its content and commits a pointer; checkout /
  pull / clone download and restore content; push uploads the objects first (like the
  git-lfs pre-push hook). `git-lfs-authenticate` over SSH is supported. Large files
  in the changes panel get a size warning and a one-click "Track with LFS".
- Dark, light or system theme; panel widths, list/tree and diff toggles, the split
  ratio and the theme are remembered between launches.
- Live refresh: a filesystem watcher picks up changes made by editors or other tools.

## Project layout

```
src/                 React + TypeScript frontend (Vite)
  components/        TabBar, Toolbar, LeftPanel, CommitGraph, RightPanel, DiffView, modals...
  lib/graph.ts       commit graph lane layout
  lib/actions.ts     UI actions (fetch, pull, push, checkout, stage, commit, LFS...)
  lib/menus.tsx      context menus
  lib/theme.ts       dark / light / system theme
  lib/highlight.ts   Shiki syntax highlighting (language by file name, lazy grammars)
  store/             zustand stores (repos, config, ui preferences)
  devMock.ts         fake backend so `npm run dev` works in a plain browser
src-tauri/src/
  git/               libgit2 engine: log, status, staging, commit, branch, merge, diff, remote...
  lfs/               Git LFS: attributes, pointers, store, smudge/clean, batch transfers, ssh auth
  auth/              GitHub web + device flows, PKCE loopback flow, provider REST APIs
  config.rs          settings, portable mode, built-in OAuth client id / secret
  secrets.rs         keychain / file token storage
  commands.rs        Tauri command layer
  watcher.rs         filesystem watcher
src-tauri/build.rs   compiles the optional GitHub client secret into the binary
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
npm run tauri build -- --no-bundle   # just the executable
# e.g. with vendored OpenSSL on Linux/macOS:
npm run tauri build -- --features vendored-openssl
```

The version is set in three places: `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`. It is shown at the top right of the window and in Settings.

### The GitHub client secret file

GitHub sign-in in the browser (the GitKraken-style flow) needs the OAuth App's
*client secret* compiled into the binary. The secret is deliberately **not** in the
repository; each build picks it up from `src-tauri/github-client-secret.txt`.

**What it changes**

| | Build **with** the file | Build **without** the file |
| --- | --- | --- |
| Accounts → *Sign in with GitHub* | Opens github.com in the browser; after you approve, the app receives the token by itself and comes back to the front. If you approved before, no page to click through at all. | Falls back to GitHub's *device flow*: the app shows an 8-character code, you enter it at github.com/login/device and approve there. |
| Everything else (push / pull / LFS / clone list, GitLab, Gitea, tokens) | identical | identical |
| Accounts dialog text | says the sign-in completes in the browser | describes the device flow |

The build itself succeeds either way; `build.rs` only prints nothing when the file is
missing.

**How to get the secret**

1. Sign in to GitHub and open <https://github.com/settings/developers> → **OAuth Apps**.
2. Open the app whose client id is built into VibeGitty (`BUILTIN_GITHUB_CLIENT_ID` in
   `src-tauri/src/config.rs`). If you build a fork, create your own app with
   **New OAuth App**: any name and homepage URL, *Authorization callback URL*
   `http://127.0.0.1:47831/callback`, and *Enable Device Flow* ticked (that keeps the
   fallback working); then build with `VIBEGITTY_GITHUB_CLIENT_ID` set to its client id.
3. Under **Client secrets** click **Generate a new client secret** (GitHub may ask for
   your password or 2FA). Copy the 40-character hex string right away: it is shown only
   once. Lost it? Generate a new one and delete the old one; already issued user tokens
   keep working.

**How to add it**

Create `src-tauri/github-client-secret.txt` (next to `Cargo.toml`) containing only the
40 characters: one line, no quotes, no spaces, no extra lines.

```bash
# bash / Git Bash
printf '%s' '<the 40-character client secret>' > src-tauri/github-client-secret.txt
```

```powershell
# PowerShell
Set-Content -NoNewline -Encoding ascii src-tauri\github-client-secret.txt '<the 40-character client secret>'
```

Then build as usual (`npm run tauri build` or `npm run tauri build -- --no-bundle`).
`.gitignore` already lists the file, so it can never be committed by accident. Setting the
`VIBEGITTY_GITHUB_CLIENT_SECRET` environment variable instead of creating the file also
works and takes precedence. Cargo re-runs `build.rs` whenever the file or the variable
changes, so switching secrets does not need a clean build.

For the GitHub Actions release workflow, store the same value as the repository secret
`VIBEGITTY_GITHUB_CLIENT_SECRET` (Settings → Secrets and variables → Actions, or
`gh secret set VIBEGITTY_GITHUB_CLIENT_SECRET < src-tauri/github-client-secret.txt`);
without it the CI packages fall back to the device flow.

Note that the secret ends up inside the shipped executable, as with GitHub Desktop and
other native clients. Someone extracting it can only present the app's identity on
GitHub's authorization page; it gives no access to any account.

### Portable (single-file) Windows build

`src-tauri/target/release/vibegitty.exe` produced by `npm run tauri build` is
self-contained (frontend assets, libgit2, libssh2, LFS and TLS are all compiled in);
it only needs the WebView2 runtime that ships with Windows 10/11. Portable releases are
kept in `release/` as `VibeGitty-<version>-x64-portable.exe`.

To run it as a portable app, put a `VibeGittyData` folder (or an empty `portable.txt`
file) next to the exe: settings and tokens are then stored there instead of
`%APPDATA%\VibeGitty` and the Windows Credential Manager. Settings from the app's
earlier name (GitConn) are migrated automatically on first start.

### Tests

```bash
cd src-tauri
cargo test --test ops
```

The tests build real repositories with libgit2 (no git binary) and cover status,
staging, commits, branches, merges and conflicts, stashes, remotes over a local bare
repository, and LFS staging / smudging / push preparation.

## Sign-in setup

### GitHub

Two OAuth flows are supported for github.com and GitHub Enterprise:

- **Browser sign-in** (default): the app opens GitHub's authorization page in your
  browser; once you approve, GitHub sends the browser back to
  `http://127.0.0.1:47831/callback`, the app exchanges the code for a token and comes
  back to the front. If you have authorized the app before, GitHub skips the approval
  page and the callback page appears right away. GitHub requires the OAuth App's
  *client secret* for this flow, so it is only available in builds that include the
  secret file described in [The GitHub client secret file](#the-github-client-secret-file).
- **Device flow**: used automatically by builds without the secret. A one-time code is
  shown in the app and confirmed on github.com; the OAuth App must have *Device Flow*
  enabled.

A client id for github.com is built into the app (`BUILTIN_GITHUB_CLIENT_ID` in
`src-tauri/src/config.rs`, overridable with the `VIBEGITTY_GITHUB_CLIENT_ID` environment
variable at build time). GitHub Enterprise servers use their own OAuth App: enter its
client id, and optionally the client secret, in the sign-in dialog; both are remembered
in Settings. A personal access token with the `repo` scope works everywhere as an
alternative.

### GitLab, Gitea / Forgejo

- **GitLab**: create an application (User Settings → Applications) with *Confidential*
  unchecked, redirect URI `http://127.0.0.1:47831/callback` and scopes `api read_user`.
  PKCE is used; no secret is needed.
- **Gitea / Forgejo**: create an OAuth2 application (public client) with the same
  redirect URI.

## Notes on the git engine

- Authentication for HTTPS remotes: the matching account token is used first; if none
  matches, an existing git credential helper (if any is configured) is tried. SSH host
  keys are accepted on first use.
- Pull is fetch + merge, fast-forward only, or fetch + rebase. Rebases use libgit2's
  rebase machinery, so a stopped rebase looks like one made by git (continue, skip and
  abort work on it, also after a restart).
- Aborting a merge / cherry-pick / revert resets the working tree to HEAD.
- Diffs have no line limit; the side-by-side view virtualizes its rows, so file
  length does not matter. Files over 8 MB are not diffed as text; LFS files show their
  pointer.
