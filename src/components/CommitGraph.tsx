import { memo, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Cloud, GitBranch, Tag } from "lucide-react";
import { useReposStore, type RepoState } from "../store/repos";
import { useUiStore } from "../store/ui";
import type { CommitInfo, RefInfo } from "../types";
import { layoutGraph, laneColorCss, type GraphInput, type RowLayout } from "../lib/graph";
import { timeAgo } from "../lib/format";
import { commitMenu } from "../lib/menus";
import { Avatar } from "./Avatar";

const ROW_H = 26;
const LANE_W = 16;
const X0 = 12;
const MAX_LANES = 24;
const WIP_OID = "__wip__";

interface Pill {
  kind: "local" | "remote" | "tag";
  name: string;
  head?: boolean;
  withRemote?: boolean;
}

function pillsFor(refs: RefInfo[] | undefined): Pill[] {
  if (!refs || refs.length === 0) return [];
  const locals = refs.filter((r) => r.kind === "local");
  const remotes = refs.filter((r) => r.kind === "remote");
  const tags = refs.filter((r) => r.kind === "tag");
  const used = new Set<string>();
  const pills: Pill[] = [];
  for (const l of locals) {
    const up = l.upstream ? remotes.find((r) => r.name === l.upstream) : undefined;
    if (up) used.add(up.name);
    pills.push({ kind: "local", name: l.name, head: l.isHead, withRemote: !!up });
  }
  for (const r of remotes) if (!used.has(r.name)) pills.push({ kind: "remote", name: r.name });
  for (const t of tags) pills.push({ kind: "tag", name: t.name });
  pills.sort((a, b) => (a.head ? -1 : b.head ? 1 : 0));
  return pills;
}

function GraphCell({ lay, width, isHead }: { lay: RowLayout; width: number; isHead: boolean }) {
  const x = (lane: number) => X0 + lane * LANE_W;
  const cx = x(lay.lane);
  const cy = ROW_H / 2;
  const color = laneColorCss(lay.color);
  const els: React.ReactNode[] = [];
  const dash = (d: boolean) => (d ? "3 3" : undefined);
  for (const e of lay.passing) {
    if (e.lane >= MAX_LANES) continue;
    els.push(
      <line key={"p" + e.lane} x1={x(e.lane)} y1={0} x2={x(e.lane)} y2={ROW_H} stroke={laneColorCss(e.color)} strokeWidth={2} strokeDasharray={dash(e.dashed)} />
    );
  }
  for (const e of lay.incoming) {
    if (e.lane >= MAX_LANES) continue;
    const xs = x(e.lane);
    els.push(
      <path
        key={"i" + e.lane}
        d={`M ${xs} 0 C ${xs} ${cy * 0.9}, ${cx} ${cy * 0.5}, ${cx} ${cy}`}
        stroke={laneColorCss(e.color)}
        strokeWidth={2}
        fill="none"
        strokeDasharray={dash(e.dashed)}
      />
    );
  }
  if (lay.fromTop) {
    els.push(<line key="ft" x1={cx} y1={0} x2={cx} y2={cy} stroke={color} strokeWidth={2} strokeDasharray={dash(lay.dashed)} />);
  }
  for (const e of lay.outgoing) {
    if (e.lane >= MAX_LANES) continue;
    const xe = x(e.lane);
    if (e.lane === lay.lane) {
      els.push(<line key={"o" + e.lane} x1={cx} y1={cy} x2={cx} y2={ROW_H} stroke={laneColorCss(e.color)} strokeWidth={2} strokeDasharray={dash(e.dashed)} />);
    } else {
      els.push(
        <path
          key={"o" + e.lane}
          d={`M ${cx} ${cy} C ${cx} ${cy + cy * 0.5}, ${xe} ${cy + cy * 0.1}, ${xe} ${ROW_H}`}
          stroke={laneColorCss(e.color)}
          strokeWidth={2}
          fill="none"
          strokeDasharray={dash(e.dashed)}
        />
      );
    }
  }
  if (lay.isWip) {
    els.push(<circle key="n" cx={cx} cy={cy} r={4.5} fill="var(--bg0)" stroke={color} strokeWidth={1.5} strokeDasharray="2 2" />);
  } else if (lay.isMerge) {
    els.push(<circle key="n" cx={cx} cy={cy} r={4.5} fill="var(--bg0)" stroke={color} strokeWidth={2} />);
  } else {
    els.push(<circle key="n" cx={cx} cy={cy} r={4.5} fill={color} />);
  }
  if (isHead) {
    // Checked-out commit: ring around the node, like GitKraken's HEAD marker.
    els.push(<circle key="h" cx={cx} cy={cy} r={8} fill="none" stroke="var(--accent)" strokeWidth={1.5} />);
  }
  return (
    <div className="gcell" style={{ width }}>
      <svg width={width} height={ROW_H}>
        {els}
      </svg>
    </div>
  );
}

const Row = memo(function Row({
  repo,
  commit,
  lay,
  width,
  top,
  selected,
  pills,
  isHead,
  wipCount,
}: {
  repo: RepoState;
  commit: CommitInfo | null;
  lay: RowLayout;
  width: number;
  top: number;
  selected: boolean;
  pills: Pill[];
  isHead: boolean;
  wipCount: number;
}) {
  const select = useReposStore((s) => s.select);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const laneColor = laneColorCss(lay.color);
  const onClick = () => select(repo.path, commit ? { kind: "commit", oid: commit.oid } : { kind: "wip" });
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!commit) {
      select(repo.path, { kind: "wip" });
      return;
    }
    select(repo.path, { kind: "commit", oid: commit.oid });
    openContextMenu(e.clientX, e.clientY, commitMenu(repo, commit));
  };
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}${isHead ? " head-row" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      onClick={onClick}
      onContextMenu={onContext}
    >
      <GraphCell lay={lay} width={width} isHead={isHead} />
      <div className="msg">
        {commit ? (
          <>
            {pills.map((pl) => (
              <span
                key={pl.kind + pl.name}
                className={`ref-pill ${pl.kind}${pl.head ? " head" : ""}`}
                style={{ ["--pill" as string]: laneColor }}
                title={pl.name}
              >
                {pl.kind === "local" ? <GitBranch /> : pl.kind === "remote" ? <Cloud /> : <Tag />}
                {pl.withRemote ? <Cloud /> : null}
                {pl.name}
              </span>
            ))}
            <span className="text" title={commit.summary}>
              {commit.summary}
            </span>
          </>
        ) : (
          <>
            <span className="ref-pill wip">// WIP</span>
            <span className="wip-text">
              {wipCount} file{wipCount === 1 ? "" : "s"} changed in the working directory
            </span>
          </>
        )}
      </div>
      <div className="author">
        {commit ? (
          <>
            <Avatar name={commit.authorName} email={commit.authorEmail} size="small" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{commit.authorName}</span>
          </>
        ) : null}
      </div>
      <div className="date">{commit ? timeAgo(commit.time) : ""}</div>
      <div className="sha">{commit ? commit.shortOid : ""}</div>
    </div>
  );
});

export function CommitGraph({ repo }: { repo: RepoState }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const loadMore = useReposStore((s) => s.loadMore);
  const st = repo.status;
  const wipCount = st ? st.staged.length + st.unstaged.length + st.conflicted.length : 0;
  const headOid = repo.info?.head.oid ?? null;

  const rows = useMemo(() => {
    const list: GraphInput[] = [];
    if (wipCount > 0) list.push({ oid: WIP_OID, parents: headOid ? [headOid] : [], wip: true });
    for (const c of repo.commits) list.push({ oid: c.oid, parents: c.parents });
    return list;
  }, [repo.commits, wipCount > 0, headOid]);

  const layout = useMemo(() => layoutGraph(rows), [rows]);
  const refsByOid = useMemo(() => {
    const m = new Map<string, RefInfo[]>();
    for (const r of repo.refs) {
      const arr = m.get(r.oid);
      if (arr) arr.push(r);
      else m.set(r.oid, [r]);
    }
    return m;
  }, [repo.refs]);
  const commitsByOid = useMemo(() => new Map(repo.commits.map((c) => [c.oid, c])), [repo.commits]);

  const count = rows.length + (repo.hasMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 15,
  });

  const selKey = repo.selected ? (repo.selected.kind === "commit" ? repo.selected.oid : "wip") : "";
  useEffect(() => {
    if (!selKey) return;
    const idx = selKey === "wip" ? 0 : rows.findIndex((r) => r.oid === selKey);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const lanes = Math.max(1, Math.min(layout.maxLanes, MAX_LANES));
  const graphWidth = Math.max(64, X0 * 2 + (lanes - 1) * LANE_W + 4);

  if (repo.commits.length === 0 && wipCount === 0) {
    return (
      <div className="graph-empty">
        {repo.loaded ? (
          repo.info?.head.unborn ? "This repository has no commits yet. Add files and make your first commit." : "No commits to show."
        ) : (
          "Loading history…"
        )}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  return (
    <>
      <div className="graph-header">
        <div className="col" style={{ width: graphWidth }}>
          Graph
        </div>
        <div className="col" style={{ flex: 1 }}>
          Commit message
        </div>
        <div className="col" style={{ width: 150 }}>
          Author
        </div>
        <div className="col" style={{ width: 110 }}>
          Date
        </div>
        <div className="col" style={{ width: 70 }}>
          SHA
        </div>
      </div>
      <div className="graph-scroll" ref={parentRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((vi) => {
            if (vi.index >= rows.length) {
              return (
                <div key="more" className="graph-more" style={{ transform: `translateY(${vi.start}px)` }}>
                  <button className="btn small" disabled={repo.loadingMore} onClick={() => void loadMore(repo.path)}>
                    {repo.loadingMore ? "Loading…" : "Load more commits"}
                  </button>
                </div>
              );
            }
            const row = rows[vi.index];
            const commit = row.wip ? null : (commitsByOid.get(row.oid) ?? null);
            const selected = row.wip ? repo.selected?.kind === "wip" : repo.selected?.kind === "commit" && repo.selected.oid === row.oid;
            return (
              <Row
                key={row.oid}
                repo={repo}
                commit={commit}
                lay={layout.rows[vi.index]}
                width={graphWidth}
                top={vi.start}
                selected={!!selected}
                pills={commit ? pillsFor(refsByOid.get(commit.oid)) : []}
                isHead={!!commit && commit.oid === headOid}
                wipCount={wipCount}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
