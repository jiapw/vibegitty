import { Database, GitBranch, Loader2 } from "lucide-react";
import { useActiveRepo } from "../store/repos";
import { formatBytes } from "../lib/format";

export function StatusBar() {
  const repo = useActiveRepo();
  if (!repo) return null;
  const head = repo.info?.head;
  const prog = repo.progress;
  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.current / prog.total) * 100)) : null;
  const phaseText = prog
    ? prog.message && prog.phase === "remote"
      ? `remote: ${prog.message}`
      : `${prog.op} · ${prog.phase}${prog.total ? ` ${prog.current}/${prog.total}` : ""}${prog.bytes ? ` · ${formatBytes(prog.bytes)}` : ""}${prog.message && prog.phase !== "remote" ? ` · ${prog.message}` : ""}`
    : null;
  return (
    <div className="statusbar">
      <span className="item" title={head?.upstream ? `Upstream: ${head.upstream}` : "No upstream"}>
        <GitBranch />
        {head?.branch ?? (head?.detached ? `detached ${head.oid?.slice(0, 7)}` : "")}
        {head?.upstream ? ` → ${head.upstream}` : ""}
        {head?.ahead ? ` ↑${head.ahead}` : ""}
        {head?.behind ? ` ↓${head.behind}` : ""}
      </span>
      {repo.lfs?.enabled ? (
        <span className="item" title={`Git LFS · ${repo.lfs.patterns.length} pattern(s) · ${repo.lfs.localObjects} local object(s)${repo.lfs.endpoint ? ` · ${repo.lfs.endpoint}` : ""}`}>
          <Database />
          LFS{repo.lfs.pendingPointers ? ` (${repo.lfs.pendingPointers} pending)` : ""}
        </span>
      ) : null}
      <span className="spacer" />
      {repo.busy ? (
        <span className="progress">
          <Loader2 className="spin" size={12} />
          <span>{repo.busy}…</span>
          {phaseText ? <span className="muted">{phaseText}</span> : null}
          {pct !== null ? (
            <span className="bar">
              <div style={{ width: `${pct}%` }} />
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="item" title={repo.path}>
        {repo.path}
      </span>
    </div>
  );
}
