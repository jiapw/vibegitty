import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Database,
  Folder,
  FolderTree,
  GitBranch,
  List,
  Loader2,
  Minus,
  Plus,
  Tag,
  Undo2,
} from "lucide-react";
import { api, errorMessage } from "../api";
import { useActiveRepo, useReposStore, type RepoState } from "../store/repos";
import { useUiStore, toast } from "../store/ui";
import { useConfigStore } from "../store/config";
import type { CommitDetail, CommitFile, StatusEntry } from "../types";
import { actions, copyText } from "../lib/actions";
import { fileMenu, folderMenu } from "../lib/menus";
import { basename, dirname, formatBytes, formatDateTime, statusLetter } from "../lib/format";
import { buildFileTree, flattenFileTree, type FolderNode, type TreeNode } from "../lib/fileTree";
import { Avatar } from "./Avatar";

const drafts = new Map<string, { summary: string; body: string; amend: boolean }>();

type Area = "unstaged" | "staged" | "conflicted";

interface FileSelection {
  area: Area;
  paths: string[];
  anchor: string | null;
}

const INDENT = 14;

function ViewToggle() {
  const view = useUiStore((s) => s.fileView);
  const setFileView = useUiStore((s) => s.setFileView);
  return (
    <span className="segmented tiny" title="File list layout">
      <button className={view === "flat" ? "active" : ""} title="Flat list" onClick={() => setFileView("flat")}>
        <List />
      </button>
      <button className={view === "tree" ? "active" : ""} title="Folder tree" onClick={() => setFileView("tree")}>
        <FolderTree />
      </button>
    </span>
  );
}

function FileRow({
  entry,
  area,
  repo,
  selected,
  targets,
  onClick,
  largeMb,
  depth,
  nameOnly,
}: {
  entry: StatusEntry;
  area: Area;
  repo: RepoState;
  selected: boolean;
  /** Entries an action on this row applies to (the multi-selection when the row is part of it). */
  targets: StatusEntry[];
  onClick: (e: React.MouseEvent) => void;
  largeMb: number;
  depth: number;
  nameOnly: boolean;
}) {
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const showDiff = useReposStore((s) => s.showDiff);
  const letter = area === "conflicted" ? "X" : statusLetter(entry.status);
  const dir = dirname(entry.path);
  const isLarge = !entry.isLfs && entry.size > largeMb * 1024 * 1024 && area === "unstaged";
  const many = targets.length > 1;
  const suffix = many ? ` (${targets.length} selected)` : "";
  const paths = targets.map((t) => t.path);
  const openDiff = () =>
    showDiff(repo.path, { kind: area === "conflicted" ? "conflict" : area, path: entry.path, oldPath: entry.oldPath });
  return (
    <div
      className={`file-row${selected ? " selected" : ""}`}
      style={{ paddingLeft: 10 + depth * INDENT }}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, fileMenu(repo, entry, area, openDiff, targets));
      }}
      title={`${entry.path}${entry.oldPath ? ` (was ${entry.oldPath})` : ""}${entry.size ? ` · ${formatBytes(entry.size)}` : ""}`}
    >
      {nameOnly ? <span className="chev" /> : null}
      <span className={`st ${letter}`}>{letter}</span>
      <span className="fname">
        {!nameOnly && dir ? <span className="fdir">{dir}/</span> : null}
        {basename(entry.path)}
      </span>
      {entry.isLfs ? <span className="tag lfs">LFS</span> : null}
      {isLarge ? (
        <span className="tag big" title={`Large file (${formatBytes(entry.size)}). Consider tracking it with Git LFS.`}>
          {formatBytes(entry.size)}
        </span>
      ) : null}
      <span className="actions" onClick={(e) => e.stopPropagation()}>
        {area === "unstaged" ? (
          <>
            {isLarge ? (
              <button className="icon-btn" title="Track this file type with Git LFS" onClick={() => void actions.lfsTrack(repo.path, `*${entry.path.slice(entry.path.lastIndexOf("."))}`)}>
                <Database />
              </button>
            ) : null}
            <button className="icon-btn danger" title={`Discard changes${suffix}`} onClick={() => actions.discard(repo.path, paths)}>
              <Undo2 />
            </button>
            <button className="icon-btn" title={`Stage${suffix}`} onClick={() => void actions.stage(repo.path, paths)}>
              <Plus />
            </button>
          </>
        ) : area === "staged" ? (
          <button className="icon-btn" title={`Unstage${suffix}`} onClick={() => void actions.unstage(repo.path, paths)}>
            <Minus />
          </button>
        ) : (
          <button className="icon-btn" title={`Mark as resolved${suffix}`} onClick={() => void actions.markResolved(repo.path, paths)}>
            <Check />
          </button>
        )}
      </span>
    </div>
  );
}

function FolderRow({
  node,
  area,
  repo,
  collapsed,
  onToggle,
}: {
  node: FolderNode<StatusEntry>;
  area: Area;
  repo: RepoState;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const paths = node.files.map((f) => f.path);
  const n = node.files.length;
  return (
    <div
      className="file-row folder"
      style={{ paddingLeft: 10 + node.depth * INDENT }}
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, folderMenu(repo, area, node.key, node.files));
      }}
      title={node.key}
    >
      {collapsed ? <ChevronRight className="chev" /> : <ChevronDown className="chev" />}
      <Folder className="ficon" />
      <span className="fname">{node.name}</span>
      <span className="count muted">{n}</span>
      <span className="actions" onClick={(e) => e.stopPropagation()}>
        {area === "unstaged" ? (
          <>
            <button className="icon-btn danger" title={`Discard changes in folder (${n} files)`} onClick={() => actions.discard(repo.path, paths)}>
              <Undo2 />
            </button>
            <button className="icon-btn" title={`Stage folder (${n} files)`} onClick={() => void actions.stage(repo.path, paths)}>
              <Plus />
            </button>
          </>
        ) : area === "staged" ? (
          <button className="icon-btn" title={`Unstage folder (${n} files)`} onClick={() => void actions.unstage(repo.path, paths)}>
            <Minus />
          </button>
        ) : (
          <button className="icon-btn" title={`Mark folder as resolved (${n} files)`} onClick={() => void actions.markResolved(repo.path, paths)}>
            <Check />
          </button>
        )}
      </span>
    </div>
  );
}

function WipPanel({ repo }: { repo: RepoState }) {
  const st = repo.status!;
  const showDiff = useReposStore((s) => s.showDiff);
  const largeMb = useConfigStore((s) => s.config?.settings.largeFileWarnMb ?? 50);
  const view = useUiStore((s) => s.fileView);
  const wipSplit = useUiStore((s) => s.wipSplit);
  const setWipSplit = useUiStore((s) => s.setWipSplit);
  const panesRef = useRef<HTMLDivElement>(null);
  const draft = drafts.get(repo.path) ?? { summary: "", body: "", amend: false };
  const [summary, setSummary] = useState(draft.summary);
  const [body, setBody] = useState(draft.body);
  const [amend, setAmend] = useState(draft.amend);
  const [sel, setSel] = useState<FileSelection>({ area: "unstaged", paths: [], anchor: null });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    drafts.set(repo.path, { summary, body, amend });
  }, [repo.path, summary, body, amend]);
  useEffect(() => {
    // switching repo: load its draft, reset selection and folder state
    const d = drafts.get(repo.path) ?? { summary: "", body: "", amend: false };
    setSummary(d.summary);
    setBody(d.body);
    setAmend(d.amend);
    setSel({ area: "unstaged", paths: [], anchor: null });
    setCollapsed({});
  }, [repo.path]);
  useEffect(() => {
    if (st.mergeMessage && !summary && st.state !== "clean") {
      const [first, ...rest] = st.mergeMessage.split("\n");
      setSummary(first);
      setBody(rest.join("\n").trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.mergeMessage, st.state]);

  const listFor = (area: Area) => (area === "unstaged" ? st.unstaged : area === "staged" ? st.staged : st.conflicted);

  const trees = useMemo(
    () => ({
      unstaged: buildFileTree(st.unstaged, (e) => e.path),
      staged: buildFileTree(st.staged, (e) => e.path),
      conflicted: buildFileTree(st.conflicted, (e) => e.path),
    }),
    [st.unstaged, st.staged, st.conflicted]
  );
  const rowsFor = (area: Area): TreeNode<StatusEntry>[] => {
    if (view === "flat") return listFor(area).map((e) => ({ kind: "file", key: e.path, name: e.path, depth: 0, item: e }));
    const prefix = area + ":";
    const c: Record<string, boolean> = {};
    for (const k of Object.keys(collapsed)) if (k.startsWith(prefix) && collapsed[k]) c[k.slice(prefix.length)] = true;
    return flattenFileTree(trees[area], c);
  };
  /** Visible files in display order (for shift-click ranges). */
  const orderFor = (area: Area): StatusEntry[] =>
    rowsFor(area)
      .filter((n): n is Extract<TreeNode<StatusEntry>, { kind: "file" }> => n.kind === "file")
      .map((n) => n.item);

  // Drop selected paths that no longer exist in their list (after staging etc.).
  useEffect(() => {
    const valid = new Set(listFor(sel.area).map((e) => e.path));
    if (sel.paths.some((p) => !valid.has(p))) {
      setSel((s) => ({ ...s, paths: s.paths.filter((p) => valid.has(p)), anchor: s.anchor && valid.has(s.anchor) ? s.anchor : null }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const onRowClick = (area: Area, entry: StatusEntry, e: React.MouseEvent) => {
    const list = orderFor(area);
    if (e.shiftKey && sel.area === area && sel.anchor) {
      const a = list.findIndex((x) => x.path === sel.anchor);
      const b = list.findIndex((x) => x.path === entry.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSel({ area, paths: list.slice(lo, hi + 1).map((x) => x.path), anchor: sel.anchor });
      } else {
        setSel({ area, paths: [entry.path], anchor: entry.path });
      }
    } else if (e.ctrlKey || e.metaKey) {
      const paths = sel.area === area ? [...sel.paths] : [];
      const i = paths.indexOf(entry.path);
      if (i >= 0) paths.splice(i, 1);
      else paths.push(entry.path);
      setSel({ area, paths, anchor: entry.path });
    } else {
      setSel({ area, paths: [entry.path], anchor: entry.path });
    }
    showDiff(repo.path, { kind: area === "conflicted" ? "conflict" : area, path: entry.path, oldPath: entry.oldPath });
  };

  const isSelected = (area: Area, entry: StatusEntry) => sel.area === area && sel.paths.includes(entry.path);
  const targetsFor = (area: Area, entry: StatusEntry): StatusEntry[] =>
    sel.area === area && sel.paths.length > 1 && sel.paths.includes(entry.path)
      ? listFor(area).filter((e) => sel.paths.includes(e.path))
      : [entry];
  const multi = (area: Area) => (sel.area === area && sel.paths.length > 1 ? sel.paths : null);
  const toggleFolder = (area: Area, key: string) => setCollapsed((c) => ({ ...c, [area + ":" + key]: !c[area + ":" + key] }));

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = panesRef.current;
    if (!el) return;
    const total = el.getBoundingClientRect().height;
    const startY = e.clientY;
    const startRatio = wipSplit;
    let ratio = startRatio;
    const onMove = (ev: MouseEvent) => {
      ratio = Math.min(0.85, Math.max(0.15, startRatio + (ev.clientY - startY) / Math.max(1, total)));
      setWipSplit(ratio);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const area = sel.area;
      setSel({ area, paths: listFor(area).map((x) => x.path), anchor: sel.anchor });
    } else if (e.key === "Escape") {
      setSel((s) => ({ ...s, paths: [], anchor: null }));
    }
  };

  const renderRows = (area: Area): ReactNode =>
    rowsFor(area).map((n) =>
      n.kind === "folder" ? (
        <FolderRow
          key={area + ":d:" + n.key}
          node={n}
          area={area}
          repo={repo}
          collapsed={!!collapsed[area + ":" + n.key]}
          onToggle={() => toggleFolder(area, n.key)}
        />
      ) : (
        <FileRow
          key={area + ":f:" + n.key}
          entry={n.item}
          area={area}
          repo={repo}
          largeMb={largeMb}
          selected={isSelected(area, n.item)}
          targets={targetsFor(area, n.item)}
          onClick={(ev) => onRowClick(area, n.item, ev)}
          depth={n.depth}
          nameOnly={view === "tree"}
        />
      )
    );

  const head = repo.info?.head;
  const branch = head?.branch ?? (head?.detached ? "detached HEAD" : "");
  const busy = !!repo.busy;
  const canCommit = (st.staged.length > 0 || amend || st.state !== "clean") && summary.trim().length > 0 && st.conflicted.length === 0 && !busy;
  const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();

  const doCommit = async () => {
    if (!canCommit) return;
    const r = await actions.commit(repo.path, message, amend);
    if (r !== undefined) {
      setSummary("");
      setBody("");
      setAmend(false);
    }
  };
  const onAmendToggle = async (v: boolean) => {
    setAmend(v);
    if (v && !summary && head?.oid) {
      const c = repo.commits.find((c) => c.oid === head.oid);
      if (c) {
        setSummary(c.summary);
        setBody(c.body);
      }
    }
  };
  const opLabel = st.state === "merge" ? "merge" : st.state === "cherrypick" ? "cherry-pick" : st.state === "revert" ? "revert" : st.state;
  const unstagedMulti = multi("unstaged");
  const stagedMulti = multi("staged");
  const conflictedMulti = multi("conflicted");

  return (
    <div className="rp-body">
      <div className="rp-header">
        <GitBranch size={14} className="muted" />
        <span className="title" title={branch}>
          {branch || "Working directory"}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {st.staged.length + st.unstaged.length + st.conflicted.length} changes
        </span>
        <ViewToggle />
      </div>
      {st.state !== "clean" ? (
        <div className="banner warn">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <AlertTriangle size={14} />
            <b>{opLabel} in progress</b>
            {st.conflicted.length ? <span>· {st.conflicted.length} conflicted file(s)</span> : <span>· ready to commit</span>}
          </div>
          <div>Resolve conflicts (take ours / theirs, or edit the files and mark them resolved), then commit to finish.</div>
          <div className="actions">
            <button className="btn small danger" onClick={() => actions.abort(repo.path, opLabel)} disabled={busy}>
              Abort {opLabel}
            </button>
          </div>
        </div>
      ) : null}
      <div className="wip-panes" ref={panesRef} tabIndex={0} onKeyDown={onKeyDown} title="Click to select, Ctrl/Shift+click for multiple, Ctrl+A for all">
        <div className="wip-pane" style={{ flex: `0 1 ${Math.round(wipSplit * 1000) / 10}%` }}>
        {st.conflicted.length ? (
          <div className="file-section">
            <div className="file-section-header">
              <span>Conflicted files</span>
              <span className="muted">{st.conflicted.length}</span>
              <span className="spacer" />
              {conflictedMulti ? (
                <>
                  <button className="btn small ghost" disabled={busy} onClick={() => void actions.resolveConflicts(repo.path, conflictedMulti, "ours")}>
                    Ours ({conflictedMulti.length})
                  </button>
                  <button className="btn small ghost" disabled={busy} onClick={() => void actions.resolveConflicts(repo.path, conflictedMulti, "theirs")}>
                    Theirs ({conflictedMulti.length})
                  </button>
                  <button className="btn small" disabled={busy} onClick={() => void actions.markResolved(repo.path, conflictedMulti)}>
                    Mark resolved ({conflictedMulti.length})
                  </button>
                </>
              ) : null}
            </div>
            {renderRows("conflicted")}
          </div>
        ) : null}
        <div className="file-section">
          <div className="file-section-header">
            <span>Unstaged files</span>
            <span className="muted">{st.unstaged.length}</span>
            <span className="spacer" />
            {unstagedMulti ? (
              <>
                <button className="btn small ghost" disabled={busy} onClick={() => actions.discard(repo.path, unstagedMulti)}>
                  Discard ({unstagedMulti.length})
                </button>
                <button className="btn small primary" disabled={busy} onClick={() => void actions.stage(repo.path, unstagedMulti)}>
                  Stage ({unstagedMulti.length})
                </button>
              </>
            ) : (
              <>
                <button className="btn small ghost" disabled={busy || st.unstaged.length === 0} onClick={() => actions.discardAll(repo.path)} title="Discard all changes">
                  Discard all
                </button>
                <button className="btn small" disabled={busy || st.unstaged.length === 0} onClick={() => void actions.stageAll(repo.path)}>
                  Stage all
                </button>
              </>
            )}
          </div>
          {st.unstaged.length === 0 ? <div className="empty-hint">No unstaged changes</div> : null}
          {renderRows("unstaged")}
        </div>
        </div>
        <div className="wip-divider" onMouseDown={startSplitDrag} title="Drag to resize" />
        <div className="wip-pane">
        <div className="file-section">
          <div className="file-section-header">
            <span>Staged files</span>
            <span className="muted">{st.staged.length}</span>
            <span className="spacer" />
            {stagedMulti ? (
              <button className="btn small" disabled={busy} onClick={() => void actions.unstage(repo.path, stagedMulti)}>
                Unstage ({stagedMulti.length})
              </button>
            ) : (
              <button className="btn small" disabled={busy || st.staged.length === 0} onClick={() => void actions.unstageAll(repo.path)}>
                Unstage all
              </button>
            )}
          </div>
          {st.staged.length === 0 ? <div className="empty-hint">Stage files to include them in the commit</div> : null}
          {renderRows("staged")}
        </div>
        </div>
      </div>
      <div className="commit-box">
        <div className="commit-fields">
          <input
            className="input summary"
            type="text"
            placeholder="Summary"
            value={summary}
            maxLength={200}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void doCommit();
            }}
          />
          <textarea
            className="input desc"
            placeholder="Description (optional)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void doCommit();
            }}
          />
        </div>
        <div className="row">
          <label className="checkbox" title="Replace the last commit with the staged changes and this message">
            <input type="checkbox" checked={amend} disabled={!head?.oid || st.state !== "clean"} onChange={(e) => void onAmendToggle(e.target.checked)} />
            Amend
          </label>
          <span style={{ flex: 1 }} />
          <span className="kbd">Ctrl+Enter</span>
          <button className="btn primary" disabled={!canCommit} onClick={() => void doCommit()}>
            {busy ? <Loader2 className="spin" /> : null}
            {amend ? "Amend commit" : st.state !== "clean" ? `Commit ${opLabel}` : `Commit${st.staged.length ? ` ${st.staged.length} file${st.staged.length === 1 ? "" : "s"}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const detailCache = new Map<string, CommitDetail>();

function CommitPanel({ repo, oid }: { repo: RepoState; oid: string }) {
  const showDiff = useReposStore((s) => s.showDiff);
  const view = useUiStore((s) => s.fileView);
  const [detail, setDetail] = useState<CommitDetail | null>(detailCache.get(repo.path + oid) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    setCollapsed({});
    const cached = detailCache.get(repo.path + oid);
    if (cached) {
      setDetail(cached);
      return;
    }
    setDetail(null);
    setError(null);
    api
      .getCommitDetail(repo.path, oid)
      .then((d) => {
        if (cancelled) return;
        if (detailCache.size > 200) detailCache.clear();
        detailCache.set(repo.path + oid, d);
        setDetail(d);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo.path, oid]);

  const refs = useMemo(() => repo.refs.filter((r) => r.oid === oid), [repo.refs, oid]);
  const rows = useMemo<TreeNode<CommitFile>[]>(() => {
    const files = detail?.files ?? [];
    if (view === "flat") return files.map((f) => ({ kind: "file", key: f.path, name: f.path, depth: 0, item: f }));
    return flattenFileTree(buildFileTree(files, (f) => f.path), collapsed);
  }, [detail, view, collapsed]);
  const c = detail?.commit ?? repo.commits.find((x) => x.oid === oid);
  if (!c) return <div className="empty-hint">{error ?? "Loading…"}</div>;
  const sel = repo.diff;
  const parentShort = (p: string) => p.slice(0, 7);
  const isHead = repo.info?.head.oid === oid;

  return (
    <div className="rp-body">
      <div className="rp-header">
        <span className="title">Commit {c.shortOid}</span>
        {isHead ? <span className="ref-pill head" style={{ ["--pill" as string]: "var(--accent)" }}>HEAD</span> : null}
        <button className="icon-btn" title="Copy SHA" onClick={() => void copyText(c.oid)}>
          <Copy />
        </button>
        <ViewToggle />
      </div>
      <div className="rp-scroll">
        <div className="detail-meta">
          <div className="who">
            <Avatar name={c.authorName} email={c.authorEmail} size="large" />
            <div>
              <div className="name">
                {c.authorName} <span className="muted" style={{ fontWeight: 400 }}>{c.authorEmail}</span>
              </div>
              <div className="when">{formatDateTime(c.authorTime)}</div>
              {c.committerName !== c.authorName || c.committerEmail !== c.authorEmail ? (
                <div className="when">
                  committed by {c.committerName} · {formatDateTime(c.time)}
                </div>
              ) : null}
            </div>
          </div>
          <div className="sha-row">
            <span title={c.oid}>{c.oid}</span>
            {c.parents.length ? (
              <span>
                parent{c.parents.length > 1 ? "s" : ""}:{" "}
                {c.parents.map((p, i) => (
                  <span key={p}>
                    {i ? ", " : ""}
                    <span
                      className="lnk"
                      onClick={() => {
                        if (repo.commits.some((x) => x.oid === p)) useReposStore.getState().select(repo.path, { kind: "commit", oid: p });
                        else toast("info", "Parent commit is not loaded yet (load more commits)");
                      }}
                    >
                      {parentShort(p)}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <span>root commit</span>
            )}
          </div>
        </div>
        {refs.length ? (
          <div className="detail-refs" style={{ paddingTop: 10 }}>
            {refs.map((r) => (
              <span key={r.fullName} className={`ref-pill ${r.kind}${r.isHead ? " head" : ""}`}>
                {r.kind === "local" ? <GitBranch /> : r.kind === "remote" ? <Cloud /> : <Tag />}
                {r.name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="detail-msg">
          <div className="summary">{c.summary}</div>
          {c.body ? <div className="body">{c.body}</div> : null}
        </div>
        <div className="file-section">
          <div className="file-section-header">
            <span>Changed files</span>
            <span className="muted">{detail ? detail.files.length : "…"}</span>
            <span className="spacer" />
            {detail ? (
              <span className="fstats" style={{ fontSize: 11 }}>
                <span style={{ color: "var(--add)" }}>+{detail.additions}</span>{" "}
                <span style={{ color: "var(--del)" }}>−{detail.deletions}</span>
              </span>
            ) : null}
          </div>
          {!detail && !error ? (
            <div className="empty-hint">
              <Loader2 className="spin" size={14} /> Loading changes…
            </div>
          ) : null}
          {error ? <div className="empty-hint" style={{ color: "var(--danger)" }}>{error}</div> : null}
          {rows.map((n) => {
            if (n.kind === "folder") {
              const isCollapsed = !!collapsed[n.key];
              return (
                <div
                  key={"d:" + n.key}
                  className="file-row folder"
                  style={{ paddingLeft: 10 + n.depth * INDENT }}
                  title={n.key}
                  onClick={() => setCollapsed((c) => ({ ...c, [n.key]: !c[n.key] }))}
                >
                  {isCollapsed ? <ChevronRight className="chev" /> : <ChevronDown className="chev" />}
                  <Folder className="ficon" />
                  <span className="fname">{n.name}</span>
                  <span className="count muted">{n.files.length}</span>
                </div>
              );
            }
            const f = n.item;
            const letter = statusLetter(f.status);
            const dir = dirname(f.path);
            const selected = !!sel && sel.kind === "commit" && sel.oid === oid && sel.path === f.path;
            return (
              <div
                key={"f:" + f.path}
                className={`file-row${selected ? " selected" : ""}`}
                style={{ paddingLeft: 10 + n.depth * INDENT }}
                title={`${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ""}`}
                onClick={() => showDiff(repo.path, { kind: "commit", oid, path: f.path, oldPath: f.oldPath })}
              >
                {view === "tree" ? <span className="chev" /> : null}
                <span className={`st ${letter}`}>{letter}</span>
                <span className="fname">
                  {view === "flat" && dir ? <span className="fdir">{dir}/</span> : null}
                  {basename(f.path)}
                </span>
                {f.isBinary ? <span className="tag">BIN</span> : null}
                <span className="fstats">
                  {f.additions ? <span className="a">+{f.additions}</span> : null}
                  {f.deletions ? <span className="d">−{f.deletions}</span> : null}
                </span>
              </div>
            );
          })}
          {detail && detail.files.length === 0 ? <div className="empty-hint">No file changes (empty commit)</div> : null}
        </div>
      </div>
    </div>
  );
}

export function RightPanel() {
  const repo = useActiveRepo();
  if (!repo) return null;
  if (repo.error) return null;
  const st = repo.status;
  const hasChanges = !!st && st.staged.length + st.unstaged.length + st.conflicted.length > 0;
  const sel = repo.selected;
  if (st && (sel?.kind === "wip" || (!sel && hasChanges))) return <WipPanel repo={repo} />;
  if (sel?.kind === "commit") return <CommitPanel repo={repo} oid={sel.oid} />;
  if (st && repo.info?.head.unborn) {
    return (
      <div className="empty-hint">
        No commits yet. Create or copy files into the repository, then stage and commit them here.
      </div>
    );
  }
  return <div className="empty-hint">{repo.loaded ? "Select a commit to see its details" : "Loading…"}</div>;
}
