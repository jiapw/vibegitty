import { FolderGit2, FolderOpen, Download, History, Loader2, Moon, Plus, Sun, X } from "lucide-react";
import { basename, dirname } from "../lib/format";
import { api } from "../api";
import type { MenuItem } from "../store/ui";
import { applyTheme } from "../lib/theme";
import logo from "../assets/logo.svg";
import { useReposStore } from "../store/repos";
import { useUiStore } from "../store/ui";
import { useConfigStore } from "../store/config";
import { actions } from "../lib/actions";

export function TabBar() {
  const order = useReposStore((s) => s.order);
  const repos = useReposStore((s) => s.repos);
  const active = useReposStore((s) => s.active);
  const setActive = useReposStore((s) => s.setActive);
  const close = useReposStore((s) => s.close);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const appInfo = useConfigStore((s) => s.appInfo);
  const resolvedTheme = useUiStore((s) => s.resolvedTheme);
  const toggleTheme = () => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    applyTheme(next);
    const cfg = useConfigStore.getState().config;
    if (cfg) void useConfigStore.getState().saveSettings({ ...cfg.settings, theme: next });
  };

  const addMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const recent = (useConfigStore.getState().config?.recentRepos ?? []).filter((p) => !order.includes(p)).slice(0, 10);
    const items: MenuItem[] = [
      { label: "Open repository…", icon: <FolderOpen />, onClick: () => void actions.openRepoDialog() },
      { label: "Clone repository…", icon: <Download />, onClick: () => actions.cloneDialog() },
      { label: "Initialize repository…", icon: <FolderGit2 />, onClick: () => void actions.initRepoDialog() },
      { separator: true },
      { label: "Open recent", icon: <History />, disabled: true, section: true },
    ];
    if (recent.length === 0) {
      items.push({ label: "No recent repositories", disabled: true });
    } else {
      for (const p of recent) {
        items.push({
          label: basename(p),
          hint: dirname(p),
          onClick: () => void useReposStore.getState().open(p),
          removeTitle: "Remove from recent",
          onRemove: () => void api.removeRecentRepo(p).then(() => useConfigStore.getState().reload()),
        });
      }
    }
    openContextMenu(r.left, r.bottom + 2, items);
  };

  return (
    <div className="tabbar">
      <div className="brand">
        <img src={logo} className="logo" alt="" />
        VibeGitty
      </div>
      <div className="tabs">
        {order.map((p) => {
          const r = repos[p];
          if (!r) return null;
          return (
            <div
              key={p}
              className={`tab${active === p ? " active" : ""}${r.error ? " error" : ""}`}
              title={p}
              onClick={() => setActive(p)}
              onAuxClick={(e) => {
                if (e.button === 1) void close(p);
              }}
            >
              {r.busy ? <Loader2 size={12} className="spin" /> : null}
              <span className="tab-name">{r.name}</span>
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  void close(p);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="tab-add" title="Open, clone or init a repository" onClick={addMenu}>
          <Plus size={16} />
        </button>
      </div>
      <button className="tab-theme" title={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
        {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      {appInfo ? (
        <span className="tab-version" title={appInfo.portable ? "Portable mode: settings are stored next to the executable" : "Version"}>
          v{appInfo.version}
          {appInfo.portable ? " · portable" : ""}
        </span>
      ) : null}
    </div>
  );
}
