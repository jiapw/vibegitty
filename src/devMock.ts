// Development-only stand-in for the Tauri backend, so the UI can be previewed
// in a plain browser (`npm run dev` without `tauri dev`). Never bundled into
// the app: main.tsx imports it only when `import.meta.env.DEV` is true and no
// Tauri runtime is present.

import type { CommitInfo, RefInfo, StatusEntry, WorkingStatus } from "./types";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const REPO = "F:\\demo\\sample-repo";
const now = Math.floor(Date.now() / 1000);

function commit(oid: string, parents: string[], summary: string, minutesAgo: number): CommitInfo {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents,
    authorName: "Demo User",
    authorEmail: "demo@example.com",
    committerName: "Demo User",
    committerEmail: "demo@example.com",
    time: now - minutesAgo * 60,
    authorTime: now - minutesAgo * 60,
    summary,
    body: "",
  };
}

const oids = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).padStart(2, "0").repeat(20));
const commits: CommitInfo[] = [
  commit(oids[0], [oids[1], oids[4]], "Merge branch 'feature/login'", 5),
  commit(oids[1], [oids[2]], "Changelog entry 3", 30),
  commit(oids[2], [oids[3]], "Changelog entry 2", 60),
  commit(oids[4], [oids[5]], "Validate credentials in login", 90),
  commit(oids[5], [oids[3]], "Add login module", 120),
  commit(oids[3], [oids[6]], "Update README", 200),
  commit(oids[6], [], "Initial commit", 400),
];
const refs: RefInfo[] = [
  { name: "main", fullName: "refs/heads/main", kind: "local", oid: oids[0], isHead: true, upstream: "origin/main", ahead: 1, behind: 0, remote: null, message: null },
  { name: "feature/login", fullName: "refs/heads/feature/login", kind: "local", oid: oids[4], isHead: false, upstream: null, ahead: 0, behind: 0, remote: null, message: null },
  { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", oid: oids[1], isHead: false, upstream: null, ahead: 0, behind: 0, remote: "origin", message: null },
  { name: "v1.0", fullName: "refs/tags/v1.0", kind: "tag", oid: oids[3], isHead: false, upstream: null, ahead: 0, behind: 0, remote: null, message: "release" },
];

const entry = (path: string, status: string, size = 1200, trackedParent: string | null = null): StatusEntry => ({ path, oldPath: null, status, isLfs: false, size, trackedParent });
const status: WorkingStatus = {
  staged: [entry("src/app.ts", "modified")],
  unstaged: [
    entry("README.md", "modified"),
    entry("build/output/a.log", "untracked"),
    entry("build/output/b.log", "untracked"),
    entry("build/output/c.log", "untracked"),
    entry("kvs4/native-sdk/filesystem/.codex/journal-debug/run-1.json", "untracked", 1200, "kvs4/native-sdk/filesystem"),
    entry("kvs4/native-sdk/filesystem/.codex/journal-debug/run-2.json", "untracked", 1200, "kvs4/native-sdk/filesystem"),
    entry("kvs4/native-sdk/filesystem/src/lib.rs", "modified"),
    entry("docs/notes.txt", "untracked"),
    entry("assets/model.bin", "untracked", 90 * 1024 * 1024),
  ],
  conflicted: [],
  state: "clean",
  mergeMessage: null,
  mergeHeads: [],
};

function move(from: StatusEntry[], to: StatusEntry[], paths: string[], toStatus?: (e: StatusEntry) => string) {
  for (const p of paths) {
    const i = from.findIndex((e) => e.path === p);
    if (i >= 0) {
      const [e] = from.splice(i, 1);
      to.push({ ...e, status: toStatus ? toStatus(e) : e.status });
    }
  }
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_app_info: () => ({ version: "dev", portable: false, builtinGithubClientId: true, githubBrowserLogin: true }),
  get_config: () => ({ openRepos: [REPO], activeRepo: REPO, recentRepos: [REPO, "F:\\demo\\other-project", "D:\\work\\api-server"], accounts: [
    { id: "acc-1", provider: "github", host: "github.com", apiBase: "https://api.github.com", webBase: "https://github.com", username: "jiapw", displayName: "Jiaping Wang", avatarUrl: null, tokenUsername: "jiapw", authKind: "oauth" },
  ], settings: {
    authorName: "", authorEmail: "", githubClientId: "", githubClientSecret: "", oauthRedirectPort: 47831, defaultCloneDir: "", commitPageSize: 400, largeFileWarnMb: 50, theme: "dark",
  }, ui: {} }),
  save_settings: () => null,
  save_ui_prefs: () => null,
  set_active_repo: () => null,
  close_repo: () => null,
  open_repo: () => handlers.get_repo_info({}),
  get_repo_info: () => ({ path: REPO, name: "sample-repo", head: { branch: "main", oid: oids[0], detached: false, unborn: false, upstream: "origin/main", ahead: 1, behind: 0 }, state: "clean", lfsEnabled: false }),
  get_refs: () => refs,
  get_log: () => ({ commits, hasMore: false }),
  get_status: () => JSON.parse(JSON.stringify(status)),
  get_remotes: () => [{ name: "origin", url: "https://github.com/demo/sample-repo.git", pushUrl: null }],
  get_stashes: () => [],
  lfs_info: () => ({ enabled: false, patterns: [], pendingPointers: 0, localObjects: 0, endpoint: null }),
  get_author: () => ({ name: "Demo User", email: "demo@example.com", source: "global" }),
  get_commit_detail: (a) => ({ commit: commits.find((c) => c.oid === a.oid) ?? commits[0], files: [{ path: "src/app.ts", oldPath: null, status: "modified", additions: 3, deletions: 1, isBinary: false }], additions: 3, deletions: 1 }),
  get_diff: (a) => {
    const t = a.target as { path: string; full?: boolean };
    const lines: { kind: string; oldLineno: number | null; newLineno: number | null; content: string }[] = [];
    let o = 1;
    let n = 1;
    const ctx = (s: string) => lines.push({ kind: "context", oldLineno: o++, newLineno: n++, content: s });
    const del = (s: string) => lines.push({ kind: "del", oldLineno: o++, newLineno: null, content: s });
    const add = (s: string) => lines.push({ kind: "add", oldLineno: null, newLineno: n++, content: s });
    const body = t.full ? 40 : 3;
    for (let i = 0; i < body; i++) ctx(`import { thing${i} } from "./mod${i}";`);
    del("const oldValue = compute(1); // " + "a long trailing comment that keeps going and going ".repeat(4));
    del("export function legacy() {}");
    add("const newValue = compute(2); // " + "an even longer replacement comment that keeps going ".repeat(6));
    for (let i = 0; i < body; i++) ctx(`  console.log("unchanged line ${i}", thing${i});`);
    add("export function shiny() { return newValue; }");
    for (let i = 0; i < body; i++) ctx(`// trailing context ${i}`);
    return { path: t.path, oldPath: null, status: "modified", isBinary: false, isLfs: false, additions: 2, deletions: 2, truncated: false, note: null,
      hunks: [{ header: `@@ -1,${o - 1} +1,${n - 1} @@`, oldStart: 1, oldLines: o - 1, newStart: 1, newLines: n - 1, lines }] };
  },
  stage_paths: (a) => { move(status.unstaged, status.staged, a.paths as string[], (e) => (e.status === "untracked" ? "added" : e.status)); return null; },
  unstage_paths: (a) => { move(status.staged, status.unstaged, a.paths as string[], (e) => (e.status === "added" ? "untracked" : e.status)); return null; },
  stage_all: () => { move(status.unstaged, status.staged, status.unstaged.map((e) => e.path), (e) => (e.status === "untracked" ? "added" : e.status)); return null; },
  unstage_all: () => { move(status.staged, status.unstaged, status.staged.map((e) => e.path), (e) => (e.status === "added" ? "untracked" : e.status)); return null; },
  discard_paths: (a) => { for (const p of a.paths as string[]) { const i = status.unstaged.findIndex((e) => e.path === p); if (i >= 0) status.unstaged.splice(i, 1); } return null; },
  discard_all: () => { status.unstaged.length = 0; return null; },
  add_gitignore_patterns: (a) => (a.patterns as string[]).length,
  remove_recent_repo: () => null,
  commit: (a) => { const oid = Math.random().toString(16).slice(2).padEnd(40, "0"); commits.unshift(commit(oid, [commits[0].oid], String(a.message).split("\n")[0], 0)); refs[0].oid = oid; status.staged.length = 0; return oid; },
  list_accounts: () => [],
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => null,
  "plugin:dialog|open": () => null,
  "plugin:opener|open_url": () => null,
};

const invoke: Invoke = async (cmd, args = {}) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`[devMock] no handler for '${cmd}'`);
  await new Promise((r) => setTimeout(r, 30));
  return h(args);
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: () => Math.floor(Math.random() * 1e9),
  unregisterCallback: () => undefined,
  unregisterListener: () => undefined,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  plugins: {},
};
(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => undefined,
};
console.info("[devMock] Tauri backend mocked for browser preview");
