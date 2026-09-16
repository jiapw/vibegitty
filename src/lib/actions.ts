import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../api";
import { useReposStore, type RunOpts } from "../store/repos";
import { confirmDialog, openModal, promptDialog, toast } from "../store/ui";
import type { MergeResult } from "../types";

function run<T>(path: string, label: string, fn: () => Promise<T>, opts?: RunOpts<T>) {
  return useReposStore.getState().run(path, label, fn, opts);
}

function selectWip(path: string) {
  useReposStore.getState().select(path, { kind: "wip" });
}

function describeMerge(path: string, r: MergeResult, verb: string): string | null {
  switch (r.kind) {
    case "up_to_date":
      return "Already up to date";
    case "fast_forward":
      return `${verb}: fast-forwarded to ${r.oid?.slice(0, 7)}`;
    case "merged":
      return `${verb}: merge commit ${r.oid?.slice(0, 7)} created`;
    case "conflicts":
      toast(
        "error",
        `${verb} produced ${r.conflicts.length} conflicted file(s). Resolve them in the changes panel, then commit.`
      );
      selectWip(path);
      return null;
  }
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("info", "Copied to clipboard");
}

export const actions = {
  // ----- repositories -----
  async openRepoDialog() {
    const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
    if (typeof dir === "string") await useReposStore.getState().open(dir);
  },
  async initRepoDialog() {
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder to initialize" });
    if (typeof dir !== "string") return;
    try {
      const info = await api.initRepo(dir);
      await useReposStore.getState().open(info.path);
      toast("success", `Initialized repository in ${info.path}`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  },
  cloneDialog() {
    openModal({ kind: "clone" });
  },

  // ----- network -----
  fetch(path: string, remote: string | null = null, prune = false) {
    return run(path, "Fetching", () => api.fetch(path, remote, prune), {
      success: (r) => `Fetched ${r.join(", ")}`,
    });
  },
  pull(path: string, ffOnly = false) {
    return run(path, "Pulling", () => api.pull(path, ffOnly), {
      success: (r) => {
        const msg = describeMerge(path, r.merge, "Pull");
        if (msg && r.lfs && (r.lfs.downloaded || r.lfs.failed.length)) {
          return `${msg}. LFS: ${r.lfs.downloaded} downloaded${r.lfs.failed.length ? `, ${r.lfs.failed.length} failed` : ""}`;
        }
        return msg;
      },
    });
  },
  push(path: string, opts: { force?: boolean; remote?: string | null; branch?: string | null; setUpstream?: boolean } = {}) {
    const go = () =>
      run(path, opts.force ? "Force pushing" : "Pushing", () =>
        api.push(path, opts.remote ?? null, opts.branch ?? null, !!opts.force, !!opts.setUpstream), {
        success: (r) =>
          `Pushed ${r.branch} → ${r.remote}/${r.remoteBranch}${r.lfsUploaded ? ` (+${r.lfsUploaded} LFS object${r.lfsUploaded === 1 ? "" : "s"})` : ""}`,
      });
    if (opts.force) {
      confirmDialog({
        title: "Force push",
        message: "Force pushing rewrites the remote branch and can discard other people's commits. Continue?",
        confirmLabel: "Force push",
        danger: true,
        onConfirm: () => void go(),
      });
      return Promise.resolve(undefined);
    }
    return go();
  },

  // ----- branches -----
  checkoutBranch(path: string, name: string) {
    return run(path, `Checking out ${name}`, () => api.checkoutBranch(path, name), { success: `Checked out ${name}` });
  },
  checkoutRemote(path: string, remoteBranch: string) {
    return run(path, `Checking out ${remoteBranch}`, () => api.checkoutRemoteBranch(path, remoteBranch, null), {
      success: (local) => `Checked out ${local} (tracking ${remoteBranch})`,
    });
  },
  checkoutCommit(path: string, oid: string, label?: string) {
    confirmDialog({
      title: "Checkout commit",
      message: `Check out ${label ?? oid.slice(0, 7)}? This detaches HEAD; create a branch if you want to keep new commits.`,
      confirmLabel: "Checkout",
      onConfirm: () => void run(path, "Checking out", () => api.checkoutCommit(path, oid), { success: "HEAD detached" }),
    });
  },
  createBranch(_path: string, target?: string, targetLabel?: string) {
    openModal({ kind: "newBranch", target, targetLabel });
  },
  mergeInto(path: string, source: string, ffOnly = false) {
    return run(path, `Merging ${source}`, () => api.mergeBranch(path, source, ffOnly), {
      success: (r) => describeMerge(path, r, `Merge ${source}`),
    });
  },
  deleteBranch(path: string, name: string) {
    confirmDialog({
      title: "Delete branch",
      message: `Delete local branch '${name}'?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteBranch(path, name, false);
          toast("success", `Deleted ${name}`);
          void useReposStore.getState().refresh(path, { log: true });
        } catch (e) {
          const msg = errorMessage(e);
          if (msg.includes("not fully merged")) {
            confirmDialog({
              title: "Branch not merged",
              message: `${msg}\n\nForce delete '${name}' and lose its commits?`,
              confirmLabel: "Force delete",
              danger: true,
              onConfirm: () =>
                void run(path, "Deleting branch", () => api.deleteBranch(path, name, true), { success: `Deleted ${name}` }),
            });
          } else {
            toast("error", msg);
          }
        }
      },
    });
  },
  renameBranch(path: string, name: string) {
    promptDialog({
      title: "Rename branch",
      label: "New name",
      initial: name,
      submitLabel: "Rename",
      onSubmit: (v) => void run(path, "Renaming", () => api.renameBranch(path, name, v.trim()), { success: `Renamed to ${v.trim()}` }),
    });
  },
  deleteRemoteBranch(path: string, remote: string, branch: string) {
    confirmDialog({
      title: "Delete remote branch",
      message: `Delete '${branch}' on remote '${remote}'? This affects everyone using that remote.`,
      confirmLabel: "Delete on remote",
      danger: true,
      onConfirm: () =>
        void run(path, "Deleting remote branch", () => api.deleteRemoteBranch(path, remote, branch), {
          success: `Deleted ${remote}/${branch}`,
        }),
    });
  },
  pushBranch(path: string, branch: string) {
    return actions.push(path, { branch, setUpstream: true });
  },

  // ----- tags -----
  createTag(_path: string, target?: string, targetLabel?: string) {
    openModal({ kind: "newTag", target, targetLabel });
  },
  deleteTag(path: string, name: string) {
    confirmDialog({
      title: "Delete tag",
      message: `Delete tag '${name}' locally?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => void run(path, "Deleting tag", () => api.deleteTag(path, name), { success: `Deleted tag ${name}` }),
    });
  },
  pushTag(path: string, name: string, remote: string) {
    return run(path, `Pushing tag ${name}`, () => api.pushTag(path, remote, name), { success: `Pushed tag ${name} to ${remote}` });
  },

  // ----- history operations -----
  cherryPick(path: string, oid: string) {
    return run(path, "Cherry-picking", () => api.cherryPick(path, oid), {
      success: (r) => describeMerge(path, r, "Cherry-pick"),
    });
  },
  revert(path: string, oid: string) {
    return run(path, "Reverting", () => api.revertCommit(path, oid), {
      success: (r) => describeMerge(path, r, "Revert"),
    });
  },
  reset(_path: string, oid: string, label: string) {
    openModal({ kind: "reset", oid, label });
  },
  abort(path: string, what: string) {
    confirmDialog({
      title: `Abort ${what}`,
      message: `Abort the ${what} in progress? The working tree is reset to HEAD and uncommitted changes are discarded.`,
      confirmLabel: "Abort",
      danger: true,
      onConfirm: () => void run(path, "Aborting", () => api.abortOperation(path), { success: `${what} aborted` }),
    });
  },

  // ----- stash -----
  stashSave(_path: string) {
    openModal({ kind: "stash" });
  },
  stashApply(path: string, index: number) {
    return run(path, "Applying stash", () => api.stashApply(path, index, false), { success: "Stash applied" });
  },
  stashPop(path: string, index: number) {
    return run(path, "Popping stash", () => api.stashApply(path, index, true), { success: "Stash popped" });
  },
  stashDrop(path: string, index: number) {
    confirmDialog({
      title: "Drop stash",
      message: `Drop stash@{${index}}? Its changes are lost.`,
      confirmLabel: "Drop",
      danger: true,
      onConfirm: () => void run(path, "Dropping stash", () => api.stashDrop(path, index), { success: "Stash dropped" }),
    });
  },

  // ----- working tree -----
  stage(path: string, paths: string[]) {
    return run(path, "Staging", () => api.stagePaths(path, paths), { refreshLog: false });
  },
  unstage(path: string, paths: string[]) {
    return run(path, "Unstaging", () => api.unstagePaths(path, paths), { refreshLog: false });
  },
  stageAll(path: string) {
    return run(path, "Staging all", () => api.stageAll(path), { refreshLog: false });
  },
  unstageAll(path: string) {
    return run(path, "Unstaging all", () => api.unstageAll(path), { refreshLog: false });
  },
  discard(path: string, paths: string[]) {
    confirmDialog({
      title: "Discard changes",
      message:
        paths.length === 1
          ? `Discard changes to '${paths[0]}'? Untracked files are deleted. This cannot be undone.`
          : `Discard changes to ${paths.length} files? Untracked files are deleted. This cannot be undone.`,
      confirmLabel: "Discard",
      danger: true,
      onConfirm: () => void run(path, "Discarding", () => api.discardPaths(path, paths), { refreshLog: false }),
    });
  },
  discardAll(path: string) {
    confirmDialog({
      title: "Discard all changes",
      message: "Discard all unstaged changes and delete untracked files? This cannot be undone.",
      confirmLabel: "Discard all",
      danger: true,
      onConfirm: () => void run(path, "Discarding", () => api.discardAll(path), { refreshLog: false }),
    });
  },
  resolveConflict(path: string, file: string, side: "ours" | "theirs") {
    return run(path, "Resolving", () => api.resolveConflict(path, file, side), { refreshLog: false });
  },
  resolveConflicts(path: string, files: string[], side: "ours" | "theirs") {
    return run(
      path,
      "Resolving",
      async () => {
        for (const f of files) await api.resolveConflict(path, f, side);
      },
      { refreshLog: false }
    );
  },
  markResolved(path: string, files: string[]) {
    return run(path, "Resolving", () => api.stagePaths(path, files), { refreshLog: false });
  },
  addToGitignore(path: string, patterns: string[]) {
    return run(path, "Updating .gitignore", () => api.addGitignorePatterns(path, patterns), {
      refreshLog: false,
      success: (n) => (n ? `Added ${n} pattern${n === 1 ? "" : "s"} to .gitignore (stage it to commit)` : "Already in .gitignore"),
    });
  },
  commit(path: string, message: string, amend: boolean) {
    return run(path, amend ? "Amending" : "Committing", () => api.commit(path, message, amend), {
      success: (oid) => `${amend ? "Amended" : "Committed"} ${oid.slice(0, 7)}`,
    });
  },

  // ----- LFS -----
  lfsTrack(path: string, pattern: string) {
    return run(path, "Updating .gitattributes", () => api.lfsTrack(path, pattern), {
      refreshLog: false,
      success: `Tracking '${pattern}' with Git LFS (stage .gitattributes to commit it)`,
    });
  },
  lfsUntrack(path: string, pattern: string) {
    return run(path, "Updating .gitattributes", () => api.lfsUntrack(path, pattern), { refreshLog: false });
  },
  lfsFetch(path: string) {
    return run(path, "Downloading LFS objects", () => api.lfsFetch(path, null), {
      refreshLog: false,
      success: (r) =>
        `LFS: ${r.downloaded} downloaded, ${r.smudged} file${r.smudged === 1 ? "" : "s"} restored${r.failed.length ? `, ${r.failed.length} failed: ${r.failed.slice(0, 2).join("; ")}` : ""}`,
    });
  },
};
