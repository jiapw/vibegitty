import { create } from "zustand";
import { api, errorMessage } from "../api";
import type {
  CommitInfo,
  DiffTarget,
  LfsInfo,
  ProgressEvent,
  RefInfo,
  RemoteInfo,
  RepoInfo,
  StashInfo,
  WorkingStatus,
} from "../types";
import { basename } from "../lib/format";
import { toast, useUiStore } from "./ui";
import { useConfigStore } from "./config";

export type Selection = { kind: "wip" } | { kind: "commit"; oid: string } | null;

export interface RepoState {
  path: string;
  name: string;
  info: RepoInfo | null;
  refs: RefInfo[];
  refSig: string;
  commits: CommitInfo[];
  hasMore: boolean;
  loadingMore: boolean;
  status: WorkingStatus | null;
  remotes: RemoteInfo[];
  stashes: StashInfo[];
  lfs: LfsInfo | null;
  selected: Selection;
  diff: DiffTarget | null;
  busy: string | null;
  progress: ProgressEvent | null;
  error: string | null;
  loaded: boolean;
}

export interface RunOpts<T> {
  refreshLog?: boolean;
  success?: string | ((r: T) => string | null);
  allowConcurrent?: boolean;
}

interface ReposStore {
  repos: Record<string, RepoState>;
  order: string[];
  active: string | null;
  ready: boolean;
  pageSize: number;
  init: () => Promise<void>;
  open: (path: string) => Promise<boolean>;
  close: (path: string) => Promise<void>;
  setActive: (path: string) => void;
  refresh: (path: string, opts?: { log?: boolean }) => Promise<void>;
  loadMore: (path: string) => Promise<void>;
  select: (path: string, sel: Selection) => void;
  showDiff: (path: string, target: DiffTarget | null) => void;
  setProgress: (path: string, ev: ProgressEvent | null) => void;
  patch: (path: string, p: Partial<RepoState>) => void;
  run: <T>(path: string, label: string, fn: () => Promise<T>, opts?: RunOpts<T>) => Promise<T | undefined>;
}

function emptyRepo(path: string): RepoState {
  return {
    path,
    name: basename(path),
    info: null,
    refs: [],
    refSig: "",
    commits: [],
    hasMore: false,
    loadingMore: false,
    status: null,
    remotes: [],
    stashes: [],
    lfs: null,
    selected: null,
    diff: null,
    busy: null,
    progress: null,
    error: null,
    loaded: false,
  };
}

export const useReposStore = create<ReposStore>((set, get) => ({
  repos: {},
  order: [],
  active: null,
  ready: false,
  pageSize: 400,

  patch: (path, p) =>
    set((s) => {
      const cur = s.repos[path];
      if (!cur) return {};
      return { repos: { ...s.repos, [path]: { ...cur, ...p } } };
    }),

  init: async () => {
    let cfg;
    try {
      cfg = await api.getConfig();
    } catch (e) {
      toast("error", errorMessage(e));
      set({ ready: true });
      return;
    }
    useConfigStore.getState().setConfig(cfg);
    if (cfg.ui && typeof cfg.ui === "object") useUiStore.getState().hydrate(cfg.ui);
    api
      .getAppInfo()
      .then((i) => useConfigStore.getState().setAppInfo(i))
      .catch(() => {});
    const repos: Record<string, RepoState> = {};
    for (const p of cfg.openRepos) repos[p] = emptyRepo(p);
    const active = cfg.activeRepo && cfg.openRepos.includes(cfg.activeRepo) ? cfg.activeRepo : (cfg.openRepos[0] ?? null);
    set({
      repos,
      order: [...cfg.openRepos],
      active,
      ready: true,
      pageSize: cfg.settings.commitPageSize || 400,
    });
    if (active) await get().refresh(active, { log: true });
    for (const p of cfg.openRepos) if (p !== active) void get().refresh(p, { log: true });
  },

  open: async (path) => {
    try {
      const info = await api.openRepo(path);
      const key = info.path;
      if (get().repos[key]) {
        get().setActive(key);
        return true;
      }
      set((s) => ({
        repos: { ...s.repos, [key]: { ...emptyRepo(key), info, name: info.name } },
        order: [...s.order, key],
        active: key,
      }));
      void useConfigStore.getState().reload();
      await get().refresh(key, { log: true });
      return true;
    } catch (e) {
      toast("error", errorMessage(e));
      return false;
    }
  },

  close: async (path) => {
    try {
      await api.closeRepo(path);
    } catch (e) {
      toast("error", errorMessage(e));
    }
    set((s) => {
      const repos = { ...s.repos };
      delete repos[path];
      const order = s.order.filter((p) => p !== path);
      let active = s.active;
      if (active === path) {
        const idx = s.order.indexOf(path);
        active = order[Math.min(idx, order.length - 1)] ?? null;
      }
      return { repos, order, active };
    });
    const active = get().active;
    void api.setActiveRepo(active);
    void useConfigStore.getState().reload();
  },

  setActive: (path) => {
    set({ active: path });
    void api.setActiveRepo(path);
    const st = get().repos[path];
    if (st && Date.now() - (lastRefresh[path] ?? 0) > 3000) void get().refresh(path);
  },

  refresh: async (path, opts = {}) => {
    const st = get().repos[path];
    if (!st) return;
    lastRefresh[path] = Date.now();
    try {
      const [info, refs, status, stashes, remotes] = await Promise.all([
        api.getRepoInfo(path),
        api.getRefs(path),
        api.getStatus(path),
        api.getStashes(path),
        api.getRemotes(path),
      ]);
      const refSig =
        refs
          .map((r) => r.fullName + "@" + r.oid)
          .sort()
          .join("|") +
        "#" +
        (info.head.oid ?? "") +
        "#" +
        stashes.map((s) => s.oid).join(",");
      const cur = get().repos[path] ?? st;
      const needLog = opts.log || refSig !== cur.refSig || (cur.commits.length === 0 && !cur.loaded);
      let logPatch: Partial<RepoState> = {};
      if (needLog) {
        const limit = Math.max(get().pageSize, cur.commits.length);
        const page = await api.getLog(path, 0, limit);
        logPatch = { commits: page.commits, hasMore: page.hasMore };
      }
      const hasChanges = status.staged.length + status.unstaged.length + status.conflicted.length > 0;
      let selected = cur.selected;
      const commits = logPatch.commits ?? cur.commits;
      const selOid = selected?.kind === "commit" ? selected.oid : null;
      if (selOid && !commits.some((c) => c.oid === selOid)) selected = null;
      if (!selected || (selected.kind === "wip" && !hasChanges)) {
        selected = hasChanges ? { kind: "wip" } : info.head.oid ? { kind: "commit", oid: info.head.oid } : null;
      }
      let diff = cur.diff;
      if (diff && diff.kind !== "commit") {
        const list = diff.kind === "staged" ? status.staged : diff.kind === "conflict" ? status.conflicted : status.unstaged;
        if (!list.some((e) => e.path === diff!.path)) diff = null;
      }
      get().patch(path, {
        info,
        name: info.name,
        refs,
        refSig,
        status,
        stashes,
        remotes,
        selected,
        diff,
        error: null,
        loaded: true,
        ...logPatch,
      });
      if (info.lfsEnabled) {
        api
          .lfsInfo(path)
          .then((lfs) => get().patch(path, { lfs }))
          .catch(() => {});
      } else if (cur.lfs) {
        get().patch(path, { lfs: null });
      }
    } catch (e) {
      get().patch(path, { error: errorMessage(e), loaded: true });
    }
  },

  loadMore: async (path) => {
    const st = get().repos[path];
    if (!st || st.loadingMore || !st.hasMore) return;
    get().patch(path, { loadingMore: true });
    try {
      const page = await api.getLog(path, st.commits.length, get().pageSize);
      const cur = get().repos[path];
      if (!cur) return;
      const seen = new Set(cur.commits.map((c) => c.oid));
      const merged = [...cur.commits, ...page.commits.filter((c) => !seen.has(c.oid))];
      get().patch(path, { commits: merged, hasMore: page.hasMore, loadingMore: false });
    } catch (e) {
      toast("error", errorMessage(e));
      get().patch(path, { loadingMore: false });
    }
  },

  select: (path, sel) => get().patch(path, { selected: sel, diff: null }),
  showDiff: (path, target) => get().patch(path, { diff: target }),

  setProgress: (path, ev) => {
    if (get().repos[path]) get().patch(path, { progress: ev });
    else useUiStore.getState().setGlobalProgress(ev);
  },

  run: async (path, label, fn, opts = {}) => {
    const st = get().repos[path];
    if (!st) return undefined;
    if (st.busy && !opts.allowConcurrent) {
      toast("info", `Please wait for "${st.busy}" to finish`);
      return undefined;
    }
    get().patch(path, { busy: label, progress: null });
    try {
      const r = await fn();
      if (opts.success) {
        const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
        if (msg) toast("success", msg);
      }
      return r;
    } catch (e) {
      toast("error", errorMessage(e));
      return undefined;
    } finally {
      get().patch(path, { busy: null, progress: null });
      await get().refresh(path, { log: opts.refreshLog ?? true });
    }
  },
}));

const lastRefresh: Record<string, number> = {};
const pendingRefresh: Record<string, number> = {};

/** Debounced refresh used by the filesystem watcher. */
export function scheduleRefresh(path: string) {
  const st = useReposStore.getState().repos[path];
  if (!st) return;
  if (pendingRefresh[path]) clearTimeout(pendingRefresh[path]);
  pendingRefresh[path] = window.setTimeout(() => {
    delete pendingRefresh[path];
    const cur = useReposStore.getState().repos[path];
    if (cur && !cur.busy) void useReposStore.getState().refresh(path);
  }, 700);
}

export function useActiveRepo(): RepoState | null {
  return useReposStore((s) => (s.active ? (s.repos[s.active] ?? null) : null));
}
