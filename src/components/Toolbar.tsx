import type { ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Cable,
  ChevronDown,
  Database,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  RefreshCw,
  Settings,
  Tag,
  User,
} from "lucide-react";
import { useActiveRepo } from "../store/repos";
import { useUiStore, openModal, type MenuItem } from "../store/ui";
import { useConfigStore } from "../store/config";
import { actions } from "../lib/actions";
import { Avatar } from "./Avatar";

function TbButton({
  icon,
  label,
  onClick,
  menu,
  disabled,
  badge,
  badgeClass,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  menu?: () => MenuItem[];
  disabled?: boolean;
  badge?: number;
  badgeClass?: string;
  title?: string;
}) {
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const showMenu = (el: HTMLElement) => {
    if (!menu) return;
    const r = el.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 2, menu());
  };
  return (
    <button
      className="tb-btn"
      disabled={disabled}
      title={title ?? label}
      onClick={(e) => {
        if (onClick) onClick();
        else showMenu(e.currentTarget);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (menu) showMenu(e.currentTarget);
      }}
    >
      {icon}
      <span>{label}</span>
      {badge ? <span className={`badge ${badgeClass ?? ""}`}>{badge}</span> : null}
      {menu ? (
        <ChevronDown
          className="caret"
          onClick={(e) => {
            e.stopPropagation();
            showMenu(e.currentTarget.parentElement as HTMLElement);
          }}
        />
      ) : null}
    </button>
  );
}

export function Toolbar() {
  const repo = useActiveRepo();
  const accounts = useConfigStore((s) => s.config?.accounts) ?? [];
  if (!repo) return null;
  const p = repo.path;
  const head = repo.info?.head;
  const busy = !!repo.busy;
  const st = repo.status;
  const hasChanges = !!st && st.staged.length + st.unstaged.length + st.conflicted.length > 0;
  const remotes = repo.remotes;
  const current = head?.branch ?? null;

  const pullMenu = (): MenuItem[] => [
    { label: "Pull (fetch + merge)", onClick: () => void actions.pull(p, "merge") },
    { label: "Pull (fetch + rebase)", onClick: () => void actions.pull(p, "rebase") },
    { label: "Pull (fast-forward only)", onClick: () => void actions.pull(p, "ff") },
    { separator: true },
    { label: "Fetch all remotes", onClick: () => void actions.fetch(p) },
    { label: "Fetch all & prune deleted branches", onClick: () => void actions.fetch(p, null, true) },
    ...remotes.map((r) => ({ label: `Fetch ${r.name}`, onClick: () => void actions.fetch(p, r.name) })),
  ];

  const pushMenu = (): MenuItem[] => [
    { label: "Push", onClick: () => void actions.push(p) },
    { label: "Push & set upstream", onClick: () => void actions.push(p, { setUpstream: true }) },
    ...(remotes.length > 1
      ? remotes.map((r) => ({ label: `Push to ${r.name}`, onClick: () => void actions.push(p, { remote: r.name, setUpstream: true }) }))
      : []),
    { separator: true },
    { label: "Force push", danger: true, onClick: () => void actions.push(p, { force: true }) },
  ];

  const mergeMenu = (): MenuItem[] => {
    const locals = repo.refs.filter((r) => r.kind === "local" && !r.isHead);
    const remotesRefs = repo.refs.filter((r) => r.kind === "remote");
    const items: MenuItem[] = [];
    if (!current) return [{ label: "Checkout a branch first", disabled: true }];
    if (locals.length === 0 && remotesRefs.length === 0) return [{ label: "No other branches", disabled: true }];
    for (const r of locals) items.push({ label: `Merge ${r.name} into ${current}`, onClick: () => void actions.mergeInto(p, r.name) });
    if (locals.length && remotesRefs.length) items.push({ separator: true });
    for (const r of remotesRefs.slice(0, 30)) items.push({ label: `Merge ${r.name} into ${current}`, onClick: () => void actions.mergeInto(p, r.name) });
    return items;
  };

  const headLabel = head?.unborn
    ? `${head.branch ?? "main"} (no commits yet)`
    : head?.detached
      ? `HEAD detached at ${head.oid?.slice(0, 7)}`
      : (head?.branch ?? "");

  return (
    <div className="toolbar">
      <div className="tb-repo" style={{ maxWidth: 260 }}>
        <div className="name" title={p}>
          {repo.name}
        </div>
        <div className="branch" title={head?.upstream ? `upstream: ${head.upstream}` : undefined}>
          <GitBranch />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{headLabel}</span>
          {head?.upstream ? (
            <span className="muted">
              {head.ahead ? ` ↑${head.ahead}` : ""}
              {head.behind ? ` ↓${head.behind}` : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        <TbButton icon={<RefreshCw />} label="Fetch" onClick={() => void actions.fetch(p)} disabled={busy || remotes.length === 0} />
        <TbButton
          icon={<ArrowDown />}
          label="Pull"
          badge={head?.behind}
          badgeClass="behind"
          onClick={() => void actions.pull(p)}
          menu={pullMenu}
          disabled={busy || remotes.length === 0}
        />
        <TbButton
          icon={<ArrowUp />}
          label="Push"
          badge={head?.ahead}
          onClick={() => void actions.push(p)}
          menu={pushMenu}
          disabled={busy || remotes.length === 0 || !current}
        />
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        <TbButton icon={<GitBranchPlus />} label="Branch" onClick={() => actions.createBranch(p)} disabled={busy || !!head?.unborn} />
        <TbButton icon={<GitMerge />} label="Merge" menu={mergeMenu} disabled={busy || !current} />
        <TbButton icon={<Archive />} label="Stash" onClick={() => actions.stashSave(p)} disabled={busy || !hasChanges} />
        <TbButton
          icon={<ArchiveRestore />}
          label="Pop"
          onClick={() => void actions.stashPop(p, 0)}
          disabled={busy || repo.stashes.length === 0}
          title="Pop the latest stash"
        />
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        <TbButton icon={<Tag />} label="Tag" onClick={() => actions.createTag(p)} disabled={busy || !!head?.unborn} />
        <TbButton icon={<Cable />} label="Remotes" onClick={() => openModal({ kind: "remotes" })} />
        <TbButton
          icon={<Database />}
          label="LFS"
          onClick={() => openModal({ kind: "lfs" })}
          badge={repo.lfs?.pendingPointers}
          badgeClass="behind"
          title="Git LFS (built-in)"
        />
      </div>
      <div className="tb-spacer" />
      <TbButton icon={<Settings />} label="Settings" onClick={() => openModal({ kind: "settings" })} />
      <button className="avatar-btn" title="Accounts" onClick={() => openModal({ kind: "accounts" })}>
        {accounts[0] ? (
          <Avatar name={accounts[0].displayName || accounts[0].username} url={accounts[0].avatarUrl} />
        ) : (
          <div className="avatar" style={{ background: "var(--bg4)" }}>
            <User size={14} />
          </div>
        )}
      </button>
    </div>
  );
}
