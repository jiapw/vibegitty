import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Check,
  Cloud,
  Copy,
  Database,
  Eye,
  EyeOff,
  GitBranchPlus,
  GitMerge,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import type { RepoState } from "../store/repos";
import type { MenuItem } from "../store/ui";
import type { CommitInfo, RefInfo, StashInfo, StatusEntry } from "../types";
import { actions, copyText } from "./actions";

const sep: MenuItem = { separator: true };

/** Ancestor directories of a path, deepest first ("a/b/c" -> ["a/b", "a"]). */
function ancestorDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Keep only directories strictly below `bound` (a directory that already holds tracked files). */
function belowBound(dirs: string[], bound: string | null): string[] {
  if (bound === null) return dirs;
  if (bound === "") return [];
  return dirs.filter((d) => d.length > bound.length && d.startsWith(bound + "/"));
}

/**
 * Directory levels that can sensibly be ignored for a folder `dir` holding
 * `entries`: none if any tracked file lives under it, otherwise the folder and
 * its ancestors down to the first ancestor that contains tracked files.
 */
function ignorableDirsForFolder(dir: string, entries: StatusEntry[]): string[] {
  if (entries.some((e) => e.status !== "untracked")) return [];
  let bound: string | null = null;
  for (const e of entries) {
    const t = e.trackedParent;
    if (t === null || t === undefined) continue;
    if (t === dir || t.startsWith(dir + "/")) return [];
    if (bound === null || t.length > bound.length) bound = t;
  }
  return belowBound([dir, ...ancestorDirs(dir)], bound);
}

/** One "Ignore folder" item per directory level, deepest first. */
function ignoreDirItems(repoPath: string, dirs: string[]): MenuItem[] {
  return dirs.map((d) => ({
    label: `Ignore folder /${d}/`,
    icon: <EyeOff />,
    onClick: () => void actions.addToGitignore(repoPath, [`/${d}/`]),
  }));
}

export function refMenu(repo: RepoState, ref: RefInfo): MenuItem[] {
  const p = repo.path;
  const head = repo.info?.head;
  const current = head?.branch ?? null;
  const remoteName = repo.remotes.find((r) => r.name === "origin")?.name ?? repo.remotes[0]?.name ?? "origin";
  if (ref.kind === "local") {
    const items: MenuItem[] = [];
    if (!ref.isHead) {
      items.push({ label: `Checkout ${ref.name}`, icon: <Check />, onClick: () => void actions.checkoutBranch(p, ref.name) });
      if (current)
        items.push({
          label: `Merge ${ref.name} into ${current}`,
          icon: <GitMerge />,
          onClick: () => void actions.mergeInto(p, ref.name),
        });
      items.push(sep);
    }
    items.push(
      { label: "Push branch", icon: <ArrowUp />, onClick: () => void actions.pushBranch(p, ref.name) },
      { label: "Create branch here…", icon: <GitBranchPlus />, onClick: () => actions.createBranch(p, ref.name, ref.name) },
      { label: "Create tag here…", icon: <Tag />, onClick: () => actions.createTag(p, ref.name, ref.name) },
      { label: "Rename…", icon: <Pencil />, onClick: () => actions.renameBranch(p, ref.name) },
      sep,
      { label: "Copy branch name", icon: <Copy />, onClick: () => void copyText(ref.name) },
      sep,
      { label: "Delete branch", icon: <Trash2 />, danger: true, disabled: ref.isHead, onClick: () => actions.deleteBranch(p, ref.name) }
    );
    return items;
  }
  if (ref.kind === "remote") {
    const remote = ref.remote ?? remoteName;
    const branch = ref.name.slice(remote.length + 1);
    const items: MenuItem[] = [
      { label: `Checkout ${ref.name}`, icon: <Check />, onClick: () => void actions.checkoutRemote(p, ref.name) },
    ];
    if (current)
      items.push({
        label: `Merge ${ref.name} into ${current}`,
        icon: <GitMerge />,
        onClick: () => void actions.mergeInto(p, ref.name),
      });
    items.push(
      sep,
      { label: `Fetch ${remote}`, icon: <RefreshCw />, onClick: () => void actions.fetch(p, remote) },
      { label: "Create branch here…", icon: <GitBranchPlus />, onClick: () => actions.createBranch(p, ref.name, ref.name) },
      { label: "Copy branch name", icon: <Copy />, onClick: () => void copyText(ref.name) },
      sep,
      {
        label: `Delete ${branch} from ${remote}`,
        icon: <Trash2 />,
        danger: true,
        onClick: () => actions.deleteRemoteBranch(p, remote, branch),
      }
    );
    return items;
  }
  // tag
  return [
    { label: `Checkout tag ${ref.name}`, icon: <Eye />, onClick: () => actions.checkoutCommit(p, ref.oid, `tag ${ref.name}`) },
    { label: "Create branch here…", icon: <GitBranchPlus />, onClick: () => actions.createBranch(p, ref.name, `tag ${ref.name}`) },
    ...(current ? [{ label: `Merge ${ref.name} into ${current}`, icon: <GitMerge />, onClick: () => void actions.mergeInto(p, ref.name) }] : []),
    sep,
    ...repo.remotes.map((r) => ({
      label: `Push tag to ${r.name}`,
      icon: <Cloud />,
      onClick: () => void actions.pushTag(p, ref.name, r.name),
    })),
    { label: "Copy tag name", icon: <Copy />, onClick: () => void copyText(ref.name) },
    sep,
    { label: "Delete tag", icon: <Trash2 />, danger: true, onClick: () => actions.deleteTag(p, ref.name) },
  ];
}

export function stashMenu(repo: RepoState, stash: StashInfo): MenuItem[] {
  const p = repo.path;
  return [
    { label: "Apply stash", icon: <Archive />, onClick: () => void actions.stashApply(p, stash.index) },
    { label: "Pop stash (apply & drop)", icon: <ArchiveRestore />, onClick: () => void actions.stashPop(p, stash.index) },
    sep,
    { label: "Drop stash", icon: <Trash2 />, danger: true, onClick: () => actions.stashDrop(p, stash.index) },
  ];
}

export function commitMenu(repo: RepoState, commit: CommitInfo): MenuItem[] {
  const p = repo.path;
  const head = repo.info?.head;
  const current = head?.branch;
  const short = commit.shortOid;
  const isHead = head?.oid === commit.oid;
  return [
    { label: `Checkout commit ${short}`, icon: <Eye />, disabled: isHead, onClick: () => actions.checkoutCommit(p, commit.oid) },
    { label: "Create branch here…", icon: <GitBranchPlus />, onClick: () => actions.createBranch(p, commit.oid, short) },
    { label: "Create tag here…", icon: <Tag />, onClick: () => actions.createTag(p, commit.oid, short) },
    sep,
    ...(current
      ? [
          { label: `Merge ${short} into ${current}`, icon: <GitMerge />, disabled: isHead, onClick: () => void actions.mergeInto(p, commit.oid) },
          { label: "Cherry-pick commit", icon: <Scissors />, disabled: isHead, onClick: () => void actions.cherryPick(p, commit.oid) },
          { label: "Revert commit", icon: <Undo2 />, onClick: () => void actions.revert(p, commit.oid) },
          { label: `Reset ${current} to this commit…`, icon: <RotateCcw />, disabled: isHead, onClick: () => actions.reset(p, commit.oid, short) },
          sep,
        ]
      : []),
    { label: "Copy SHA", icon: <Copy />, onClick: () => void copyText(commit.oid), hint: short },
    { label: "Copy commit message", icon: <History />, onClick: () => void copyText(commit.summary + (commit.body ? "\n\n" + commit.body : "")) },
  ];
}

export function folderMenu(
  repo: RepoState,
  area: "unstaged" | "staged" | "conflicted",
  dir: string,
  entries: StatusEntry[]
): MenuItem[] {
  const p = repo.path;
  const paths = entries.map((e) => e.path);
  const n = paths.length;
  const sfx = ` (${n} file${n === 1 ? "" : "s"})`;
  const items: MenuItem[] = [];
  if (area === "unstaged") {
    items.push(
      { label: `Stage folder${sfx}`, icon: <Plus />, onClick: () => void actions.stage(p, paths) },
      { label: `Discard changes in folder${sfx}`, icon: <Undo2 />, danger: true, onClick: () => actions.discard(p, paths) }
    );
    const ignorable = ignorableDirsForFolder(dir, entries);
    if (ignorable.length) {
      items.push(sep, ...ignoreDirItems(p, ignorable));
    }
  } else if (area === "staged") {
    items.push({ label: `Unstage folder${sfx}`, icon: <Undo2 />, onClick: () => void actions.unstage(p, paths) });
  } else {
    items.push(
      { label: `Take ours for folder${sfx}`, icon: <Check />, onClick: () => void actions.resolveConflicts(p, paths, "ours") },
      { label: `Take theirs for folder${sfx}`, icon: <Check />, onClick: () => void actions.resolveConflicts(p, paths, "theirs") },
      { label: `Mark folder as resolved${sfx}`, icon: <Plus />, onClick: () => void actions.markResolved(p, paths) }
    );
  }
  items.push(sep, { label: "Copy folder path", icon: <Copy />, onClick: () => void copyText(dir) });
  return items;
}

export function fileMenu(
  repo: RepoState,
  entry: StatusEntry,
  area: "unstaged" | "staged" | "conflicted",
  showDiff: () => void,
  targetEntries: StatusEntry[] = [entry]
): MenuItem[] {
  const p = repo.path;
  const targets = targetEntries.map((e) => e.path);
  const base = entry.path.includes("/") ? entry.path.slice(entry.path.lastIndexOf("/") + 1) : entry.path;
  const ext = base.includes(".") && !base.startsWith(".") ? base.slice(base.lastIndexOf(".")) : null;
  const n = targets.length;
  const many = n > 1;
  const sfx = many ? ` (${n} files)` : "";
  const items: MenuItem[] = [{ label: "View changes", icon: <Eye />, onClick: showDiff }, sep];
  if (area === "unstaged") {
    items.push(
      { label: `Stage${sfx}`, icon: <Plus />, onClick: () => void actions.stage(p, targets) },
      { label: `Discard changes${sfx}`, icon: <Undo2 />, danger: true, onClick: () => actions.discard(p, targets) }
    );
  } else if (area === "staged") {
    items.push({ label: `Unstage${sfx}`, icon: <Undo2 />, onClick: () => void actions.unstage(p, targets) });
  } else {
    items.push(
      { label: `Take ours (current branch)${sfx}`, icon: <Check />, onClick: () => void actions.resolveConflicts(p, targets, "ours") },
      { label: `Take theirs (incoming)${sfx}`, icon: <Check />, onClick: () => void actions.resolveConflicts(p, targets, "theirs") },
      { label: `Mark as resolved (stage)${sfx}`, icon: <Plus />, onClick: () => void actions.markResolved(p, targets) }
    );
  }
  items.push(sep);
  if (area === "unstaged" && entry.status === "untracked") {
    const untracked = (many ? targetEntries : [entry]).filter((e) => e.status === "untracked").map((e) => e.path);
    items.push({
      label: untracked.length > 1 ? `Ignore ${untracked.length} untracked files (.gitignore)` : "Ignore this file (.gitignore)",
      icon: <EyeOff />,
      onClick: () => void actions.addToGitignore(p, untracked.map((t) => "/" + t)),
    });
    items.push(...ignoreDirItems(p, belowBound(ancestorDirs(entry.path), entry.trackedParent ?? null)));
    if (ext) {
      items.push({ label: `Ignore all *${ext} files`, icon: <EyeOff />, onClick: () => void actions.addToGitignore(p, [`*${ext}`]) });
    }
    items.push(sep);
  }
  if (!entry.isLfs && ext && area === "unstaged") {
    items.push({
      label: `Track *${ext} with Git LFS`,
      icon: <Database />,
      onClick: () => void actions.lfsTrack(p, `*${ext}`),
    });
  }
  items.push({ label: "Copy path", icon: <Copy />, onClick: () => void copyText(entry.path) });
  return items;
}
