import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, KeyRound, Loader2, Lock, Search } from "lucide-react";
import { Modal } from "../Modal";
import { closeModal, openModal, toast, useUiStore } from "../../store/ui";
import { useConfigStore } from "../../store/config";
import { useReposStore } from "../../store/repos";
import { api, errorMessage } from "../../api";
import type { RemoteRepo } from "../../types";
import { formatBytes, joinPath, repoNameFromUrl } from "../../lib/format";
import { Avatar } from "../Avatar";

export function CloneModal() {
  const accounts = useConfigStore((s) => s.config?.accounts) ?? [];
  const defaultDir = useConfigStore((s) => s.config?.settings.defaultCloneDir ?? "");
  const lastDir = useUiStore((s) => s.lastCloneDir);
  const progress = useUiStore((s) => s.globalProgress);
  const [tab, setTab] = useState<"url" | "account">("url");
  const [url, setUrl] = useState("");
  // The folder of the previous clone wins over the Settings default.
  const [dir, setDir] = useState(lastDir || defaultDir);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [filter, setFilter] = useState("");
  const [useSsh, setUseSsh] = useState(false);

  useEffect(() => {
    if (!nameTouched) setName(url ? repoNameFromUrl(url) : "");
  }, [url, nameTouched]);

  useEffect(() => {
    if (tab !== "account" || !accountId) return;
    setLoadingRepos(true);
    setRepos(null);
    setReposError(null);
    api
      .listRemoteRepos(accountId)
      .then(setRepos)
      .catch((e) => setReposError(errorMessage(e)))
      .finally(() => setLoadingRepos(false));
  }, [tab, accountId]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (repos ?? []).filter((r) => !f || r.fullName.toLowerCase().includes(f) || (r.description ?? "").toLowerCase().includes(f));
  }, [repos, filter]);

  const dest = dir && name ? joinPath(dir, name) : "";
  const canClone = !!url.trim() && !!dest && !busy;

  const pickDir = async () => {
    const d = await open({ directory: true, multiple: false, title: "Clone into folder" });
    if (typeof d === "string") setDir(d);
  };

  const clone = async () => {
    if (!canClone) return;
    setBusy(true);
    try {
      const info = await api.cloneRepo(url.trim(), dest);
      toast("success", `Cloned into ${info.path}`);
      useUiStore.getState().setLastCloneDir(dir);
      closeModal();
      await useReposStore.getState().open(info.path);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
      useUiStore.getState().setGlobalProgress(null);
    }
  };

  const account = accounts.find((a) => a.id === accountId);
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;

  return (
    <Modal
      title="Clone a repository"
      icon={<Download size={16} />}
      wide
      onClose={() => !busy && closeModal()}
      footer={
        <>
          {busy && progress ? (
            <span className="left progress-inline">
              <Loader2 className="spin" size={14} />
              {progress.op} · {progress.phase}
              {progress.total ? ` ${progress.current}/${progress.total}` : ""}
              {pct !== null ? ` (${pct}%)` : ""}
              {progress.bytes ? ` · ${formatBytes(progress.bytes)}` : ""}
              {progress.message ? ` · ${progress.message}` : ""}
            </span>
          ) : null}
          <button className="btn" onClick={closeModal} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canClone} onClick={() => void clone()}>
            {busy ? <Loader2 className="spin" /> : <Download />} Clone
          </button>
        </>
      }
    >
      <div className="form">
        <div className="segmented">
          <button className={tab === "url" ? "active" : ""} onClick={() => setTab("url")}>
            Clone with URL
          </button>
          <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")} disabled={accounts.length === 0}>
            From your accounts{accounts.length === 0 ? " (connect one first)" : ""}
          </button>
        </div>

        {tab === "account" ? (
          <>
            <div className="row-inline">
              <select className="input" style={{ width: 300 }} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName || a.username} · {a.host}
                  </option>
                ))}
              </select>
              <div style={{ position: "relative", flex: 1 }}>
                <Search size={13} style={{ position: "absolute", left: 8, top: 8, color: "var(--muted)" }} />
                <input className="input" style={{ paddingLeft: 26 }} placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <label className="checkbox" title="Use the SSH clone URL (requires ssh-agent or ~/.ssh keys)">
                <input type="checkbox" checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} />
                SSH
              </label>
            </div>
            <div className="list" style={{ maxHeight: 260 }}>
              {loadingRepos ? (
                <div className="list-item">
                  <Loader2 className="spin" size={14} /> Loading repositories…
                </div>
              ) : null}
              {reposError ? (
                <div className="list-item repos-error">
                  <div className="main">
                    <div className="t">Could not load repositories</div>
                    <div className="s">{reposError}</div>
                  </div>
                  <button className="btn small" onClick={() => openModal({ kind: "accounts", reauth: accountId })}>
                    <KeyRound /> Sign in again
                  </button>
                </div>
              ) : null}
              {repos && repos.length === 0 ? <div className="list-item muted">No repositories found for this account.</div> : null}
              {filtered.slice(0, 200).map((r) => {
                const u = useSsh && r.sshUrl ? r.sshUrl : r.cloneUrl;
                return (
                  <div
                    key={r.fullName}
                    className={`list-item${url === u ? " selected" : ""}`}
                    onClick={() => {
                      setUrl(u);
                      setNameTouched(false);
                    }}
                  >
                    {account ? <Avatar name={account.displayName || account.username} url={account.avatarUrl} size="small" /> : null}
                    <div className="main">
                      <div className="t">
                        {r.fullName} {r.private ? <Lock size={11} style={{ color: "var(--muted)" }} /> : null}
                      </div>
                      <div className="s">{r.description || u}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        <div className="field">
          <label>Repository URL</label>
          <input
            className="input"
            autoFocus={tab === "url"}
            placeholder="https://github.com/user/repo.git or git@gitlab.com:group/project.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          <div className="hint">HTTPS URLs use your connected accounts for authentication; SSH URLs use ssh-agent or ~/.ssh keys.</div>
        </div>
        <div className="row-inline">
          <div className="field" style={{ flex: 1 }}>
            <label>Clone into</label>
            <div className="row-inline">
              <input className="input" placeholder="Parent folder" value={dir} onChange={(e) => setDir(e.target.value)} disabled={busy} />
              <button className="btn" onClick={() => void pickDir()} disabled={busy}>
                <FolderOpen /> Browse
              </button>
            </div>
          </div>
          <div className="field" style={{ width: 220 }}>
            <label>Folder name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              disabled={busy}
            />
          </div>
        </div>
        {dest ? (
          <div className="hint muted">
            Full path: <code>{dest}</code>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
