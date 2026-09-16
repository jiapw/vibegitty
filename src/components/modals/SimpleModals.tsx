import { useEffect, useState } from "react";
import { AlertTriangle, Database, Plus, Trash2 } from "lucide-react";
import { Modal } from "../Modal";
import { closeModal, toast, type ModalSpec } from "../../store/ui";
import { useActiveRepo, useReposStore } from "../../store/repos";
import { api, errorMessage } from "../../api";
import { actions } from "../../lib/actions";

export function ConfirmModal({ spec }: { spec: Extract<ModalSpec, { kind: "confirm" }> }) {
  return (
    <Modal
      title={spec.title}
      icon={spec.danger ? <AlertTriangle size={16} style={{ color: "var(--warn)" }} /> : undefined}
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button
            className={`btn ${spec.danger ? "danger" : "primary"}`}
            autoFocus
            onClick={() => {
              closeModal();
              spec.onConfirm();
            }}
          >
            {spec.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div style={{ whiteSpace: "pre-wrap" }}>{spec.message}</div>
    </Modal>
  );
}

export function InputModal({ spec }: { spec: Extract<ModalSpec, { kind: "input" }> }) {
  const [value, setValue] = useState(spec.initial ?? "");
  const submit = () => {
    if (!value.trim()) return;
    closeModal();
    spec.onSubmit(value);
  };
  return (
    <Modal
      title={spec.title}
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {spec.submitLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{spec.label}</label>
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={spec.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </Modal>
  );
}

export function NewBranchModal({ spec }: { spec: Extract<ModalSpec, { kind: "newBranch" }> }) {
  const repo = useActiveRepo();
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  if (!repo) return null;
  const from = spec.targetLabel ?? repo.info?.head.branch ?? "HEAD";
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    closeModal();
    await useReposStore.getState().run(repo.path, "Creating branch", () => api.createBranch(repo.path, n, spec.target ?? null, checkout), {
      success: `Created branch ${n}${checkout ? " and checked it out" : ""}`,
    });
  };
  return (
    <Modal
      title="Create branch"
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void submit()}>
            Create branch
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label>Branch name</label>
          <input className="input" autoFocus value={name} placeholder="feature/my-change" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
          <div className="hint">
            Created from <code>{from}</code>
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
          Checkout the new branch
        </label>
      </div>
    </Modal>
  );
}

export function NewTagModal({ spec }: { spec: Extract<ModalSpec, { kind: "newTag" }> }) {
  const repo = useActiveRepo();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(false);
  if (!repo) return null;
  const from = spec.targetLabel ?? repo.info?.head.branch ?? "HEAD";
  const remote = repo.remotes.find((r) => r.name === "origin")?.name ?? repo.remotes[0]?.name;
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    closeModal();
    const r = await useReposStore.getState().run(repo.path, "Creating tag", () => api.createTag(repo.path, n, spec.target ?? null, message || null), {
      success: `Created tag ${n}`,
    });
    if (r !== undefined && push && remote) await actions.pushTag(repo.path, n, remote);
  };
  return (
    <Modal
      title="Create tag"
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void submit()}>
            Create tag
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label>Tag name</label>
          <input className="input" autoFocus value={name} placeholder="v1.0.0" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
          <div className="hint">
            At <code>{from}</code>
          </div>
        </div>
        <div className="field">
          <label>Message (optional, creates an annotated tag)</label>
          <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
        {remote ? (
          <label className="checkbox">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            Push tag to {remote}
          </label>
        ) : null}
      </div>
    </Modal>
  );
}

export function StashModal() {
  const repo = useActiveRepo();
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  if (!repo) return null;
  const submit = async () => {
    closeModal();
    await useReposStore.getState().run(repo.path, "Stashing", () => api.stashSave(repo.path, message || null, untracked), {
      success: "Changes stashed",
    });
  };
  return (
    <Modal
      title="Stash changes"
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            Stash
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label>Message (optional)</label>
          <input className="input" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
          Include untracked files
        </label>
      </div>
    </Modal>
  );
}

export function ResetModal({ spec }: { spec: Extract<ModalSpec, { kind: "reset" }> }) {
  const repo = useActiveRepo();
  const [mode, setMode] = useState<"soft" | "mixed" | "hard">("mixed");
  if (!repo) return null;
  const branch = repo.info?.head.branch ?? "HEAD";
  const submit = async () => {
    closeModal();
    await useReposStore.getState().run(repo.path, "Resetting", () => api.resetTo(repo.path, spec.oid, mode), {
      success: `Reset ${branch} to ${spec.label} (${mode})`,
    });
  };
  const opts: { v: "soft" | "mixed" | "hard"; t: string; d: string }[] = [
    { v: "soft", t: "Soft", d: "Move the branch pointer; keep the index and working tree (changes stay staged)." },
    { v: "mixed", t: "Mixed", d: "Move the branch pointer and reset the index; keep working tree changes unstaged." },
    { v: "hard", t: "Hard", d: "Move the branch pointer and discard all local changes. Cannot be undone." },
  ];
  return (
    <Modal
      title={`Reset ${branch} to ${spec.label}`}
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className={`btn ${mode === "hard" ? "danger" : "primary"}`} onClick={() => void submit()}>
            Reset ({mode})
          </button>
        </>
      }
    >
      <div className="radio-list">
        {opts.map((o) => (
          <label key={o.v} className={mode === o.v ? "active" : ""}>
            <input type="radio" checked={mode === o.v} onChange={() => setMode(o.v)} />
            <div>
              <div>{o.t}</div>
              <div className="d">{o.d}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function RemotesModal() {
  const repo = useActiveRepo();
  const [name, setName] = useState(repo?.remotes.length ? "" : "origin");
  const [url, setUrl] = useState("");
  if (!repo) return null;
  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    const r = await useReposStore.getState().run(repo.path, "Adding remote", () => api.addRemote(repo.path, name, url), {
      refreshLog: false,
      success: `Added remote ${name}`,
    });
    if (r !== undefined) {
      setName("");
      setUrl("");
    }
  };
  const remove = (n: string) =>
    void useReposStore.getState().run(repo.path, "Removing remote", () => api.removeRemote(repo.path, n), { success: `Removed remote ${n}` });
  return (
    <Modal title="Remotes" footer={<button className="btn" onClick={closeModal}>Close</button>}>
      <div className="form">
        {repo.remotes.length === 0 ? <div className="muted">No remotes configured.</div> : null}
        {repo.remotes.length ? (
          <div className="list">
            {repo.remotes.map((r) => (
              <div key={r.name} className="list-item" style={{ cursor: "default" }}>
                <div className="main">
                  <div className="t">{r.name}</div>
                  <div className="s" title={r.url ?? ""}>
                    {r.url}
                    {r.pushUrl && r.pushUrl !== r.url ? ` (push: ${r.pushUrl})` : ""}
                  </div>
                </div>
                <button className="icon-btn" title="Fetch" onClick={() => void actions.fetch(repo.path, r.name)}>
                  ↓
                </button>
                <button className="icon-btn danger" title="Remove remote" onClick={() => remove(r.name)}>
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="field">
          <label>Add remote</label>
          <div className="row-inline">
            <input className="input" style={{ width: 120 }} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="https://github.com/user/repo.git or git@host:user/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
            <button className="btn" disabled={!name.trim() || !url.trim()} onClick={() => void add()}>
              <Plus /> Add
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function LfsModal() {
  const repo = useActiveRepo();
  const [pattern, setPattern] = useState("");
  const [info, setInfo] = useState(repo?.lfs ?? null);
  const [loading, setLoading] = useState(false);
  const path = repo?.path;
  const refreshKey = repo?.lfs;
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    api
      .lfsInfo(path)
      .then(setInfo)
      .catch((e) => toast("error", errorMessage(e)))
      .finally(() => setLoading(false));
  }, [path, refreshKey]);
  if (!repo) return null;
  const track = async () => {
    const p = pattern.trim();
    if (!p) return;
    await actions.lfsTrack(repo.path, p);
    setPattern("");
  };
  return (
    <Modal
      title="Git LFS (built-in)"
      icon={<Database size={16} />}
      footer={
        <>
          <span className="left muted" style={{ fontSize: 11 }}>
            {info?.endpoint ? `Endpoint: ${info.endpoint}` : "Endpoint is derived from the remote URL when needed"}
          </span>
          <button className="btn" onClick={closeModal}>
            Close
          </button>
        </>
      }
    >
      <div className="form">
        <div className="muted">
          Large files matching the patterns below are stored as LFS objects. Staging, checkout, pull and push handle them automatically: no git-lfs
          installation is required.
        </div>
        <div className="row-inline" style={{ gap: 16 }}>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              STATUS
            </div>
            <div>{loading ? "…" : info?.enabled ? "Enabled" : "Not used yet"}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              LOCAL OBJECTS
            </div>
            <div>{info?.localObjects ?? "…"}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              PENDING DOWNLOADS
            </div>
            <div>{info?.pendingPointers ?? "…"}</div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={!info?.enabled || !!repo.busy} onClick={() => void actions.lfsFetch(repo.path)} title="Download missing LFS objects and restore pointer files">
            Fetch LFS objects
          </button>
        </div>
        <div className="field">
          <label>Tracked patterns (.gitattributes)</label>
          {info?.patterns.length ? (
            <div className="list">
              {info.patterns.map((p) => (
                <div key={p} className="list-item" style={{ cursor: "default" }}>
                  <div className="main">
                    <div className="t mono">{p}</div>
                  </div>
                  <button className="icon-btn danger" title="Stop tracking" onClick={() => void actions.lfsUntrack(repo.path, p)}>
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">No patterns tracked in the root .gitattributes.</div>
          )}
        </div>
        <div className="field">
          <label>Track a new pattern</label>
          <div className="row-inline">
            <input className="input mono" placeholder="*.psd" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void track()} />
            <button className="btn" disabled={!pattern.trim() || !!repo.busy} onClick={() => void track()}>
              <Plus /> Track
            </button>
          </div>
          <div className="hint">
            Adds <code>{pattern.trim() || "pattern"} filter=lfs diff=lfs merge=lfs -text</code> to .gitattributes. Stage and commit .gitattributes so
            collaborators use LFS too.
          </div>
        </div>
      </div>
    </Modal>
  );
}
