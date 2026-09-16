import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Settings as SettingsIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import logo from "../../assets/logo.svg";
import { GithubMark } from "../BrandMarks";
import { Modal } from "../Modal";
import { closeModal, toast } from "../../store/ui";
import { useConfigStore } from "../../store/config";
import { useActiveRepo, useReposStore } from "../../store/repos";
import { api, errorMessage } from "../../api";
import type { AuthorInfo, Settings } from "../../types";

const REPO_URL = "https://github.com/jiapw/vibegitty";

export function SettingsModal() {
  const config = useConfigStore((s) => s.config);
  const appInfo = useConfigStore((s) => s.appInfo);
  const saveSettings = useConfigStore((s) => s.saveSettings);
  const repo = useActiveRepo();
  const [s, setS] = useState<Settings>(config?.settings ?? {
    authorName: "",
    authorEmail: "",
    githubClientId: "",
    githubClientSecret: "",
    oauthRedirectPort: 47831,
    defaultCloneDir: "",
    commitPageSize: 400,
    largeFileWarnMb: 50,
    theme: "dark",
  });
  const [gitAuthor, setGitAuthor] = useState<AuthorInfo | null>(null);
  useEffect(() => {
    if (repo) api.getAuthor(repo.path).then(setGitAuthor).catch(() => setGitAuthor(null));
  }, [repo?.path]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((cur) => ({ ...cur, [k]: v }));

  const save = async () => {
    const ok = await saveSettings({ ...s, commitPageSize: Math.max(50, Math.min(5000, s.commitPageSize || 400)) });
    if (ok) {
      useReposStore.setState({ pageSize: s.commitPageSize || 400 });
      toast("success", "Settings saved");
      closeModal();
    }
  };

  const writeGitConfig = async (global: boolean) => {
    if (!s.authorName.trim() || !s.authorEmail.trim()) return;
    try {
      await api.setAuthor(global ? null : (repo?.path ?? null), s.authorName, s.authorEmail, global);
      toast("success", `Saved to ${global ? "global" : "repository"} git config`);
      if (repo) setGitAuthor(await api.getAuthor(repo.path));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const pickDir = async () => {
    const d = await open({ directory: true, multiple: false, title: "Default clone folder" });
    if (typeof d === "string") set("defaultCloneDir", d);
  };

  return (
    <Modal
      title="Settings"
      icon={<SettingsIcon size={16} />}
      wide
      footer={
        <>
          <div className="left about">
            <img src={logo} className="about-logo" alt="" />
            <span className="about-name">VibeGitty</span>
            {appInfo ? (
              <span className="about-version">
                v{appInfo.version}
                {appInfo.portable ? " · portable" : ""}
              </span>
            ) : null}
            <a
              className="about-link"
              href={REPO_URL}
              title={REPO_URL}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(REPO_URL);
              }}
            >
              <GithubMark size={14} /> github.com/jiapw/vibegitty
            </a>
          </div>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label>Appearance</label>
          <div className="segmented" style={{ alignSelf: "flex-start" }}>
            {(["system", "dark", "light"] as const).map((t) => (
              <button key={t} className={s.theme === t ? "active" : ""} onClick={() => set("theme", t)}>
                {t === "system" ? "Follow system" : t === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Commit author</label>
          <div className="row-inline">
            <input className="input" placeholder="Name" value={s.authorName} onChange={(e) => set("authorName", e.target.value)} />
            <input className="input" placeholder="email@example.com" value={s.authorEmail} onChange={(e) => set("authorEmail", e.target.value)} />
          </div>
          <div className="hint">
            {gitAuthor && gitAuthor.name ? (
              <>
                Git config currently says <code>{gitAuthor.name} &lt;{gitAuthor.email}&gt;</code> ({gitAuthor.source}). Leave the fields empty to use it.
              </>
            ) : (
              "No author configured in git config. Fill in your name and email here, or write them to git config."
            )}
          </div>
          <div className="row-inline">
            <button className="btn small" disabled={!s.authorName.trim() || !s.authorEmail.trim()} onClick={() => void writeGitConfig(true)}>
              Write to global git config
            </button>
            <button className="btn small" disabled={!repo || !s.authorName.trim() || !s.authorEmail.trim()} onClick={() => void writeGitConfig(false)}>
              Write to this repository
            </button>
          </div>
        </div>
        {!appInfo?.builtinGithubClientId ? (
          <div className="settings-grid">
            <div className="field">
              <label>GitHub OAuth App client id</label>
              <input className="input mono" value={s.githubClientId} onChange={(e) => set("githubClientId", e.target.value)} placeholder="from github.com/settings/developers" />
            </div>
            <div className="field">
              <label>GitHub OAuth App client secret (browser sign-in)</label>
              <input className="input mono" type="password" value={s.githubClientSecret} onChange={(e) => set("githubClientSecret", e.target.value)} placeholder="empty = device flow" />
            </div>
          </div>
        ) : null}
        <div className="settings-grid">
          <div className="field">
            <label>OAuth redirect port</label>
            <input className="input" type="number" value={s.oauthRedirectPort} onChange={(e) => set("oauthRedirectPort", Number(e.target.value) || 47831)} />
          </div>
          <div className="field">
            <label>Commits per page</label>
            <input className="input" type="number" value={s.commitPageSize} onChange={(e) => set("commitPageSize", Number(e.target.value) || 400)} />
          </div>
          <div className="field">
            <label>Large file warning (MB)</label>
            <input className="input" type="number" value={s.largeFileWarnMb} onChange={(e) => set("largeFileWarnMb", Number(e.target.value) || 50)} />
          </div>
        </div>
        <div className="hint muted">
          GitLab / Gitea OAuth redirect URI: <code>http://127.0.0.1:{s.oauthRedirectPort}/callback</code>
        </div>
        <div className="field">
          <label>Default clone folder</label>
          <div className="row-inline">
            <input className="input" value={s.defaultCloneDir} onChange={(e) => set("defaultCloneDir", e.target.value)} />
            <button className="btn" onClick={() => void pickDir()}>
              <FolderOpen /> Browse
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
