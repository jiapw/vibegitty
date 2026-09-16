import { ChevronRight, Download, FolderGit2, FolderOpen } from "lucide-react";
import { BitbucketMark, GiteaMark, GithubMark, GitlabMark } from "./BrandMarks";
import logo from "../assets/logo.svg";
import { useConfigStore } from "../store/config";
import { useReposStore } from "../store/repos";
import { actions } from "../lib/actions";
import { basename } from "../lib/format";
import { openModal } from "../store/ui";

export function Welcome() {
  const recent = useConfigStore((s) => s.config?.recentRepos) ?? [];
  const accounts = useConfigStore((s) => s.config?.accounts) ?? [];
  const open = useReposStore((s) => s.open);
  return (
    <div className="welcome">
      <div className="card">
        <h1>
          <img src={logo} alt="" />
          VibeGitty
        </h1>
        <p>A cross-platform Git client with a built-in git engine and Git LFS support. No external git or git-lfs needed.</p>
        <div className="actions">
          <button className="big-btn" onClick={() => void actions.openRepoDialog()}>
            <FolderOpen />
            <span className="t">Open repository</span>
            <span className="s">Open an existing local repository</span>
          </button>
          <button className="big-btn" onClick={() => actions.cloneDialog()}>
            <Download />
            <span className="t">Clone repository</span>
            <span className="s">From a URL or one of your accounts</span>
          </button>
          <button className="big-btn" onClick={() => void actions.initRepoDialog()}>
            <FolderGit2 />
            <span className="t">Initialize repository</span>
            <span className="s">Start tracking a folder with git</span>
          </button>
        </div>
        {accounts.length === 0 ? (
          <button className="connect-btn" onClick={() => openModal({ kind: "accounts" })}>
            <span className="logos">
              <span className="logo" title="GitHub">
                <GithubMark size={26} />
              </span>
              <span className="logo" title="GitLab">
                <GitlabMark size={26} />
              </span>
              <span className="logo" title="Bitbucket">
                <BitbucketMark size={24} />
              </span>
              <span className="logo" title="Gitea / Forgejo">
                <GiteaMark size={26} />
              </span>
            </span>
            <span className="txt">
              <span className="t">Connect GitHub, GitLab, Bitbucket, Gitea or another git server</span>
              <span className="s">Sign in with your browser or a token to clone, pull and push over HTTPS and Git LFS</span>
            </span>
            <ChevronRight className="chev" />
          </button>
        ) : null}
        {recent.length ? (
          <div className="recent">
            <h3>Recent repositories</h3>
            {recent.slice(0, 8).map((p) => (
              <div key={p} className="item" onClick={() => void open(p)}>
                <FolderGit2 size={16} style={{ color: "var(--muted)" }} />
                <div style={{ minWidth: 0 }}>
                  <div>{basename(p)}</div>
                  <div className="p">{p}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
