import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { scheduleRefresh, useActiveRepo, useReposStore } from "./store/repos";
import { useUiStore } from "./store/ui";
import { useConfigStore } from "./store/config";
import type { AuthStatus, ProgressEvent } from "./types";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { LeftPanel } from "./components/LeftPanel";
import { CommitGraph } from "./components/CommitGraph";
import { RightPanel } from "./components/RightPanel";
import { DiffView } from "./components/DiffView";
import { StatusBar } from "./components/StatusBar";
import { Welcome } from "./components/Welcome";
import { ContextMenu } from "./components/ContextMenu";
import { Toasts } from "./components/Toasts";
import { ModalHost } from "./components/ModalHost";
import { AlertTriangle } from "lucide-react";
import { applyTheme } from "./lib/theme";

function Resizer({ side }: { side: "left" | "right" }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const ui = useUiStore.getState();
    const startW = side === "left" ? ui.leftWidth : ui.rightWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (side === "left") ui.setLeftWidth(Math.min(600, Math.max(180, startW + delta)));
      else ui.setRightWidth(Math.min(900, Math.max(280, startW - delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return <div className="resizer" onMouseDown={onMouseDown} />;
}

function CenterPane() {
  const repo = useActiveRepo();
  if (!repo) return null;
  if (repo.error) {
    return (
      <div className="error-pane">
        <AlertTriangle size={28} />
        <div>{repo.error}</div>
        <button className="btn" onClick={() => void useReposStore.getState().refresh(repo.path, { log: true })}>
          Retry
        </button>
      </div>
    );
  }
  if (repo.diff) return <DiffView repo={repo} />;
  return <CommitGraph repo={repo} />;
}

export default function App() {
  const ready = useReposStore((s) => s.ready);
  const active = useReposStore((s) => s.active);
  const leftWidth = useUiStore((s) => s.leftWidth);
  const rightWidth = useUiStore((s) => s.rightWidth);
  const themePref = useConfigStore((s) => s.config?.settings.theme ?? "dark");
  const started = useRef(false);

  useEffect(() => {
    applyTheme(themePref === "light" || themePref === "system" ? themePref : "dark");
  }, [themePref]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void useReposStore.getState().init();
    const unlisten: Promise<UnlistenFn>[] = [
      listen<ProgressEvent>("git-progress", (e) => {
        const ev = e.payload;
        useReposStore.getState().setProgress(ev.repo, ev.done ? null : ev);
      }),
      listen<{ repo: string }>("repo-changed", (e) => scheduleRefresh(e.payload.repo)),
      listen<AuthStatus>("auth-status", (e) => useConfigStore.getState().setAuthStatus(e.payload)),
    ];
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest("input, textarea, [contenteditable], .diff-body")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
      document.removeEventListener("contextmenu", onCtx);
    };
  }, []);

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      <TabBar />
      {active ? (
        <>
          <Toolbar />
          <div className="workspace">
            <div className="left-panel" style={{ width: leftWidth }}>
              <LeftPanel />
            </div>
            <Resizer side="left" />
            <div className="center-pane">
              <CenterPane />
            </div>
            <Resizer side="right" />
            <div className="right-panel" style={{ width: rightWidth }}>
              <RightPanel />
            </div>
          </div>
          <StatusBar />
        </>
      ) : (
        <Welcome />
      )}
      <ModalHost />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
