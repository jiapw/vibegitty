import { create } from "zustand";
import type { ReactNode } from "react";
import type { ProgressEvent } from "../types";
import { api } from "../api";

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
  /** Render as a non-interactive section heading. */
  section?: boolean;
  /** Shows a small remove button at the right of the item. */
  onRemove?: () => void;
  removeTitle?: string;
}

export type ModalSpec =
  | { kind: "clone" }
  | { kind: "newBranch"; target?: string; targetLabel?: string }
  | { kind: "newTag"; target?: string; targetLabel?: string }
  | { kind: "accounts"; reauth?: string }
  | { kind: "settings" }
  | { kind: "remotes" }
  | { kind: "stash" }
  | { kind: "lfs" }
  | { kind: "reset"; oid: string; label: string }
  | { kind: "checkoutRemote"; remoteBranch: string }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | {
      kind: "input";
      title: string;
      label: string;
      placeholder?: string;
      initial?: string;
      submitLabel?: string;
      onSubmit: (value: string) => void;
    };

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

interface UiStore {
  modal: ModalSpec | null;
  openModal: (m: ModalSpec) => void;
  closeModal: () => void;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  openContextMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeContextMenu: () => void;
  toasts: Toast[];
  addToast: (kind: Toast["kind"], message: string) => void;
  removeToast: (id: number) => void;
  leftWidth: number;
  rightWidth: number;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  collapsed: Record<string, boolean>;
  toggleCollapsed: (key: string) => void;
  expanded: Record<string, boolean>;
  setExpanded: (key: string, v: boolean) => void;
  branchFilter: string;
  setBranchFilter: (s: string) => void;
  globalProgress: ProgressEvent | null;
  setGlobalProgress: (p: ProgressEvent | null) => void;
  fileView: "flat" | "tree";
  setFileView: (v: "flat" | "tree") => void;
  diffView: "unified" | "split";
  setDiffView: (v: "unified" | "split") => void;
  /** Soft-wrap long lines in the diff view. */
  diffWrap: boolean;
  setDiffWrap: (v: boolean) => void;
  /** Height share of the unstaged pane in the changes panel (0..1). */
  wipSplit: number;
  setWipSplit: (v: number) => void;
  /** Parent folder used by the last clone. */
  lastCloneDir: string;
  setLastCloneDir: (v: string) => void;
  resolvedTheme: "dark" | "light";
  setResolvedTheme: (t: "dark" | "light") => void;
  /** Load layout preferences saved in the app config (portable-friendly). */
  hydrate: (prefs: Record<string, unknown>) => void;
}

function loadNumber(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key);
    return v ? Number(v) || def : def;
  } catch {
    return def;
  }
}

function loadJson<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}

/** Plain-string preferences are stored as-is (see `save`). */
function loadString(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}

let flushTimer: number | undefined;

/** Preferences are cached in localStorage and written through to the config file. */
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* ignore */
  }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    const s = useUiStore.getState();
    void api
      .saveUiPrefs({
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        collapsed: s.collapsed,
        expanded: s.expanded,
        fileView: s.fileView,
        diffView: s.diffView,
        diffWrap: s.diffWrap,
        wipSplit: s.wipSplit,
        lastCloneDir: s.lastCloneDir,
      })
      .catch(() => {});
  }, 400);
}

let toastId = 1;

export const useUiStore = create<UiStore>((set, get) => ({
  modal: null,
  openModal: (m) => set({ modal: m, contextMenu: null }),
  closeModal: () => set({ modal: null }),
  contextMenu: null,
  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  closeContextMenu: () => set({ contextMenu: null }),
  toasts: [],
  addToast: (kind, message) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    const ttl = kind === "error" ? 9000 : 4000;
    setTimeout(() => get().removeToast(id), ttl);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  leftWidth: loadNumber("ui.leftWidth", 260),
  rightWidth: loadNumber("ui.rightWidth", 380),
  setLeftWidth: (w) => {
    save("ui.leftWidth", String(w));
    set({ leftWidth: w });
  },
  setRightWidth: (w) => {
    save("ui.rightWidth", String(w));
    set({ rightWidth: w });
  },
  collapsed: loadJson("ui.collapsed", {}),
  toggleCollapsed: (key) =>
    set((s) => {
      const collapsed = { ...s.collapsed, [key]: !s.collapsed[key] };
      save("ui.collapsed", collapsed);
      return { collapsed };
    }),
  expanded: loadJson("ui.expanded", {}),
  setExpanded: (key, v) =>
    set((s) => {
      const expanded = { ...s.expanded, [key]: v };
      save("ui.expanded", expanded);
      return { expanded };
    }),
  branchFilter: "",
  setBranchFilter: (branchFilter) => set({ branchFilter }),
  globalProgress: null,
  setGlobalProgress: (globalProgress) => set({ globalProgress }),
  fileView: loadString("ui.fileView", "flat") === "tree" ? "tree" : "flat",
  setFileView: (fileView) => {
    save("ui.fileView", fileView);
    set({ fileView });
  },
  diffView: loadString("ui.diffView", "unified") === "split" ? "split" : "unified",
  setDiffView: (diffView) => {
    save("ui.diffView", diffView);
    set({ diffView });
  },
  diffWrap: loadJson<boolean>("ui.diffWrap", false) === true,
  setDiffWrap: (diffWrap) => {
    save("ui.diffWrap", diffWrap);
    set({ diffWrap });
  },
  wipSplit: Math.min(0.85, Math.max(0.15, loadNumber("ui.wipSplit", 0.55))),
  setWipSplit: (wipSplit) => {
    save("ui.wipSplit", String(wipSplit));
    set({ wipSplit });
  },
  lastCloneDir: loadString("ui.lastCloneDir", ""),
  setLastCloneDir: (lastCloneDir) => {
    save("ui.lastCloneDir", lastCloneDir);
    set({ lastCloneDir });
  },
  resolvedTheme: "dark",
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  hydrate: (prefs) => {
    const p: Partial<UiStore> = {};
    if (typeof prefs.leftWidth === "number") p.leftWidth = Math.min(600, Math.max(180, prefs.leftWidth));
    if (typeof prefs.rightWidth === "number") p.rightWidth = Math.min(900, Math.max(280, prefs.rightWidth));
    if (prefs.collapsed && typeof prefs.collapsed === "object") p.collapsed = prefs.collapsed as Record<string, boolean>;
    if (prefs.expanded && typeof prefs.expanded === "object") p.expanded = prefs.expanded as Record<string, boolean>;
    if (prefs.fileView === "flat" || prefs.fileView === "tree") p.fileView = prefs.fileView;
    if (prefs.diffView === "unified" || prefs.diffView === "split") p.diffView = prefs.diffView;
    if (typeof prefs.diffWrap === "boolean") p.diffWrap = prefs.diffWrap;
    if (typeof prefs.wipSplit === "number") p.wipSplit = Math.min(0.85, Math.max(0.15, prefs.wipSplit));
    if (typeof prefs.lastCloneDir === "string") p.lastCloneDir = prefs.lastCloneDir;
    if (Object.keys(p).length) set(p);
  },
}));

export const toast = (kind: Toast["kind"], message: string) => useUiStore.getState().addToast(kind, message);
export const openModal = (m: ModalSpec) => useUiStore.getState().openModal(m);
export const closeModal = () => useUiStore.getState().closeModal();
export const confirmDialog = (opts: Omit<Extract<ModalSpec, { kind: "confirm" }>, "kind">) =>
  openModal({ kind: "confirm", ...opts });
export const promptDialog = (opts: Omit<Extract<ModalSpec, { kind: "input" }>, "kind">) =>
  openModal({ kind: "input", ...opts });
