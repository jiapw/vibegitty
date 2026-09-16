import { useMemo } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Tag,
} from "lucide-react";
import { useActiveRepo, useReposStore, type RepoState } from "../store/repos";
import { useUiStore, type MenuItem } from "../store/ui";
import type { RefInfo, StashInfo } from "../types";
import { refMenu, stashMenu } from "../lib/menus";
import { actions } from "../lib/actions";
import { timeAgo } from "../lib/format";

interface Node {
  key: string;
  label: string;
  depth: number;
  folder: boolean;
  children?: Node[];
  ref?: RefInfo;
  stash?: StashInfo;
}

function buildTree(refs: RefInfo[], sectionKey: string): Node[] {
  const root: Node = { key: sectionKey, label: "", depth: -1, folder: true, children: [] };
  for (const r of refs) {
    const parts = r.name.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = cur.children!.find((c) => c.folder && c.label === seg);
      if (!child) {
        child = { key: cur.key + "/" + seg, label: seg, depth: cur.depth + 1, folder: true, children: [] };
        cur.children!.push(child);
      }
      cur = child;
    }
    cur.children!.push({
      key: cur.key + "/" + parts[parts.length - 1],
      label: parts[parts.length - 1],
      depth: cur.depth + 1,
      folder: false,
      ref: r,
    });
  }
  const sortNodes = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.folder === b.folder ? a.label.localeCompare(b.label) : a.folder ? -1 : 1));
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  sortNodes(root.children!);
  return root.children!;
}

function flatten(nodes: Node[], expanded: Record<string, boolean>, out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n);
    if (n.folder) {
      const isOpen = expanded[n.key] ?? n.depth < 1;
      if (isOpen && n.children) flatten(n.children, expanded, out);
    }
  }
  return out;
}

function Row({
  node,
  repo,
  selected,
  expanded,
}: {
  node: Node;
  repo: RepoState;
  selected: boolean;
  expanded: boolean;
}) {
  const setExpanded = useUiStore((s) => s.setExpanded);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const select = useReposStore((s) => s.select);
  const ref = node.ref;
  const stash = node.stash;

  const menuItems = (): MenuItem[] => (ref ? refMenu(repo, ref) : stash ? stashMenu(repo, stash) : []);
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (node.folder) return;
    openContextMenu(e.clientX, e.clientY, menuItems());
  };
  const onClick = () => {
    if (node.folder) {
      setExpanded(node.key, !expanded);
      return;
    }
    if (ref) select(repo.path, { kind: "commit", oid: ref.oid });
  };
  const onDouble = () => {
    if (node.folder || repo.busy) return;
    if (ref?.kind === "local" && !ref.isHead) void actions.checkoutBranch(repo.path, ref.name);
    else if (ref?.kind === "remote") void actions.checkoutRemote(repo.path, ref.name);
    else if (ref?.kind === "tag") actions.checkoutCommit(repo.path, ref.oid, `tag ${ref.name}`);
    else if (stash) void actions.stashApply(repo.path, stash.index);
  };

  let icon = null;
  if (node.folder) icon = <FolderOpen className="icon" />;
  else if (ref?.kind === "local") icon = <GitBranch className="icon" />;
  else if (ref?.kind === "remote") icon = <Cloud className="icon" />;
  else if (ref?.kind === "tag") icon = <Tag className="icon" />;
  else if (stash) icon = <Archive className="icon" />;

  return (
    <div
      className={`tree-row${ref?.isHead ? " head" : ""}${selected ? " selected" : ""}`}
      style={{ paddingLeft: 8 + node.depth * 14 }}
      onClick={onClick}
      onDoubleClick={onDouble}
      onContextMenu={onContext}
      title={ref ? `${ref.name}${ref.upstream ? ` → ${ref.upstream}` : ""}` : stash ? stash.message : node.label}
    >
      {node.folder ? (
        expanded ? (
          <ChevronDown className="chev" />
        ) : (
          <ChevronRight className="chev" />
        )
      ) : (
        <span className="chev" />
      )}
      {icon}
      <span className="label">{stash ? `stash@{${stash.index}}: ${stash.message}` : node.label}</span>
      {stash ? <span className="ab">{timeAgo(stash.time)}</span> : null}
      {ref?.kind === "local" && (ref.ahead || ref.behind) ? (
        <span className="ab">
          {ref.ahead ? (
            <span>
              <ArrowUp />
              {ref.ahead}
            </span>
          ) : null}
          {ref.behind ? (
            <span>
              <ArrowDown />
              {ref.behind}
            </span>
          ) : null}
        </span>
      ) : null}
      {!node.folder ? (
        <button
          className="icon-btn row-menu"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.left, r.bottom, menuItems());
          }}
        >
          <MoreHorizontal />
        </button>
      ) : null}
    </div>
  );
}

function Section({
  id,
  title,
  count,
  nodes,
  repo,
  action,
  emptyText,
}: {
  id: string;
  title: string;
  count: number;
  nodes: Node[];
  repo: RepoState;
  action?: { icon: React.ReactNode; title: string; onClick: () => void };
  emptyText: string;
}) {
  const collapsed = useUiStore((s) => s.collapsed[id] ?? false);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const expanded = useUiStore((s) => s.expanded);
  const selectedOid = repo.selected?.kind === "commit" ? repo.selected.oid : null;
  const rows = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  return (
    <div>
      <div className="section-header" onClick={() => toggleCollapsed(id)}>
        {collapsed ? <ChevronRight /> : <ChevronDown />}
        <span>{title}</span>
        <span className="count">{count}</span>
        <span className="spacer" />
        {action ? (
          <button
            className="icon-btn"
            title={action.title}
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
          >
            {action.icon}
          </button>
        ) : null}
      </div>
      {!collapsed
        ? rows.length === 0
          ? <div className="tree-empty">{emptyText}</div>
          : rows.map((n) => (
              <Row
                key={n.key}
                node={n}
                repo={repo}
                selected={!!n.ref && !n.folder && n.ref.oid === selectedOid}
                expanded={expanded[n.key] ?? n.depth < 1}
              />
            ))
        : null}
    </div>
  );
}

export function LeftPanel() {
  const repo = useActiveRepo();
  const filter = useUiStore((s) => s.branchFilter);
  const setFilter = useUiStore((s) => s.setBranchFilter);
  const refs = repo?.refs ?? [];
  const stashes = repo?.stashes ?? [];
  const f = filter.trim().toLowerCase();

  const local = useMemo(() => {
    const items = refs.filter((r) => r.kind === "local" && (!f || r.name.toLowerCase().includes(f)));
    return f ? items.map<Node>((r) => ({ key: "l/" + r.name, label: r.name, depth: 0, folder: false, ref: r })) : buildTree(items, "local");
  }, [refs, f]);
  const remote = useMemo(() => {
    const items = refs.filter((r) => r.kind === "remote" && (!f || r.name.toLowerCase().includes(f)));
    return f ? items.map<Node>((r) => ({ key: "r/" + r.name, label: r.name, depth: 0, folder: false, ref: r })) : buildTree(items, "remote");
  }, [refs, f]);
  const tags = useMemo(() => {
    const items = refs.filter((r) => r.kind === "tag" && (!f || r.name.toLowerCase().includes(f)));
    return f ? items.map<Node>((r) => ({ key: "t/" + r.name, label: r.name, depth: 0, folder: false, ref: r })) : buildTree(items, "tags");
  }, [refs, f]);
  const stashNodes = useMemo(
    () =>
      stashes
        .filter((s) => !f || s.message.toLowerCase().includes(f))
        .map<Node>((s) => ({ key: "s/" + s.index, label: s.message, depth: 0, folder: false, stash: s })),
    [stashes, f]
  );

  if (!repo) return null;
  const p = repo.path;
  return (
    <>
      <div className="lp-search">
        <div style={{ position: "relative" }}>
          <Search size={13} style={{ position: "absolute", left: 8, top: 8, color: "var(--muted)" }} />
          <input
            className="input"
            style={{ paddingLeft: 26 }}
            placeholder="Filter branches, tags, stashes"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="lp-scroll">
        <Section
          id="local"
          title="Local"
          count={refs.filter((r) => r.kind === "local").length}
          nodes={local}
          repo={repo}
          action={{ icon: <Plus />, title: "New branch", onClick: () => actions.createBranch(p) }}
          emptyText={repo.info?.head.unborn ? "No commits yet" : "No local branches"}
        />
        <Section
          id="remote"
          title="Remote"
          count={refs.filter((r) => r.kind === "remote").length}
          nodes={remote}
          repo={repo}
          action={{ icon: <RefreshCw />, title: "Fetch all", onClick: () => void actions.fetch(p) }}
          emptyText={repo.remotes.length ? "No remote branches (fetch?)" : "No remotes configured"}
        />
        <Section
          id="tags"
          title="Tags"
          count={refs.filter((r) => r.kind === "tag").length}
          nodes={tags}
          repo={repo}
          action={{ icon: <Plus />, title: "New tag", onClick: () => actions.createTag(p) }}
          emptyText="No tags"
        />
        <Section
          id="stashes"
          title="Stashes"
          count={stashes.length}
          nodes={stashNodes}
          repo={repo}
          action={{ icon: <Plus />, title: "Stash changes", onClick: () => actions.stashSave(p) }}
          emptyText="No stashes"
        />
      </div>
    </>
  );
}
