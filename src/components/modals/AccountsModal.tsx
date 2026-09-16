import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, Loader2, LogIn, Plus, RefreshCw, Trash2, User } from "lucide-react";
import { Modal } from "../Modal";
import { closeModal, confirmDialog, toast } from "../../store/ui";
import { useConfigStore } from "../../store/config";
import { api, errorMessage } from "../../api";
import { PROVIDER_LABELS, type Account, type Provider } from "../../types";
import { Avatar } from "../Avatar";
import { ProviderMark } from "../BrandMarks";

type Method = "browser" | "token";

/** `reauth`: id of an account whose sign-in should start right away. */
export function AccountsModal({ reauth }: { reauth?: string }) {
  const config = useConfigStore((s) => s.config);
  const appInfo = useConfigStore((s) => s.appInfo);
  const authStatus = useConfigStore((s) => s.authStatus);
  const loginBusy = useConfigStore((s) => s.loginBusy);
  const setLoginBusy = useConfigStore((s) => s.setLoginBusy);
  const reload = useConfigStore((s) => s.reload);
  const removeAccount = useConfigStore((s) => s.removeAccount);
  const accounts = config?.accounts ?? [];
  const settings = config?.settings;

  const [adding, setAdding] = useState(accounts.length === 0);
  const [provider, setProvider] = useState<Provider>("github");
  const [method, setMethod] = useState<Method>("browser");
  const [server, setServer] = useState("");
  const [clientId, setClientId] = useState(settings?.githubClientId ?? "");
  const [clientSecret, setClientSecret] = useState(settings?.githubClientSecret ?? "");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  // Values to apply after a provider switch instead of that provider's defaults.
  const prefill = useRef<{ server: string; method: Method; username: string } | null>(null);

  useEffect(() => {
    if (provider === "github") {
      setClientId(settings?.githubClientId ?? "");
      setClientSecret(settings?.githubClientSecret ?? "");
    } else {
      setClientId("");
      setClientSecret("");
    }
    const p = prefill.current;
    prefill.current = null;
    if (p) {
      setServer(p.server);
      setMethod(p.method);
      setUsername(p.username);
      return;
    }
    if (provider === "bitbucket" || provider === "generic") setMethod("token");
    setServer(provider === "github" ? "" : provider === "gitlab" ? "https://gitlab.com" : provider === "bitbucket" ? "https://bitbucket.org" : "");
  }, [provider, settings?.githubClientId, settings?.githubClientSecret]);

  useEffect(() => {
    return () => {
      if (useConfigStore.getState().loginBusy) void api.cancelLogin();
    };
  }, []);

  const browserAvailable = provider === "github" || provider === "gitlab" || provider === "gitea";
  // github.com uses the client id compiled into the app; GitHub Enterprise
  // servers need their own OAuth App id.
  const isGithubCom = provider === "github" && /^(https?:\/\/)?(www\.)?github\.com\/?$/i.test(server.trim() || "github.com");
  const clientIdBuiltIn = isGithubCom && !!appInfo?.builtinGithubClientId;
  const port = settings?.oauthRedirectPort ?? 47831;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const run = async (login: () => Promise<Account>) => {
    setLoginBusy(true);
    useConfigStore.getState().setAuthStatus(null);
    try {
      const acc = await login();
      toast("success", `Connected ${acc.displayName || acc.username} @ ${acc.host}`);
      await reload();
      setAdding(false);
      setToken("");
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setLoginBusy(false);
      useConfigStore.getState().setAuthStatus(null);
    }
  };

  const start = () =>
    run(() => {
      if (method === "browser") {
        if (provider === "github") return api.githubLogin(clientIdBuiltIn ? null : clientId || null, clientIdBuiltIn ? null : clientSecret || null, server || null);
        return api.oauthPkceLogin(provider, server, clientId);
      }
      return api.tokenLogin(provider, server, username || null, token);
    });

  /**
   * Get a fresh token for an existing account. GitHub OAuth starts right away
   * (the account is updated in place); other logins open the sign-in form
   * prefilled for that account.
   */
  const reauthAccount = (a: Account) => {
    const githubCom = a.provider === "github" && a.host.toLowerCase() === "github.com";
    if (a.provider === "github" && a.authKind === "oauth") {
      void run(() => api.githubLogin(null, null, githubCom ? null : a.webBase, a.id));
      return;
    }
    const fields = { server: githubCom ? "" : a.webBase, method: (a.authKind === "oauth" ? "browser" : "token") as Method, username: a.username };
    if (a.provider !== provider) prefill.current = fields;
    setProvider(a.provider);
    setServer(fields.server);
    setMethod(fields.method);
    setUsername(fields.username);
    setAdding(true);
  };

  useEffect(() => {
    if (!reauth) return;
    const a = accounts.find((x) => x.id === reauth);
    if (a) reauthAccount(a);
    // Runs once, for the account the caller asked to refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progress =
    authStatus?.stage === "device_code" ? (
      <div className="form">
        <div className="muted">Enter this code in the browser window that just opened:</div>
        <div className="device-code">{authStatus.userCode}</div>
        <div className="row-inline">
          <button className="btn" onClick={() => authStatus.verificationUri && void openUrl(authStatus.verificationUri)}>
            <ExternalLink /> Open {authStatus.verificationUri}
          </button>
          <button className="btn ghost" onClick={() => authStatus.userCode && void navigator.clipboard.writeText(authStatus.userCode)}>
            Copy code
          </button>
          <span className="progress-inline">
            <Loader2 className="spin" size={14} /> Waiting for authorization…
          </span>
        </div>
      </div>
    ) : authStatus?.stage === "browser" ? (
      <div className="progress-inline">
        <Loader2 className="spin" size={14} /> Approve the sign-in in the browser window that just opened… {authStatus.message}
        <button className="btn small ghost" onClick={() => authStatus.verificationUri && void openUrl(authStatus.verificationUri)}>
          Open it again
        </button>
      </div>
    ) : authStatus?.stage === "waiting" ? (
      <div className="progress-inline">
        <Loader2 className="spin" size={14} /> Verifying token…
      </div>
    ) : null;

  const cancel = () => {
    void api.cancelLogin();
  };

  const tokenHelp: Record<Provider, string> = {
    github: "Personal access token with the 'repo' scope (classic) or a fine-grained token with Contents read/write.",
    gitlab: "Personal access token with the 'api' or 'read_repository' + 'write_repository' scopes.",
    gitea: "Access token with repository read/write permissions.",
    bitbucket: "App password (Repositories: read/write). Enter your Bitbucket username too.",
    generic: "Username and password / token used for git over HTTPS.",
  };

  const canStart =
    !loginBusy &&
    (method === "browser"
      ? provider === "github"
        ? clientIdBuiltIn || !!clientId.trim()
        : !!clientId.trim() && !!server.trim()
      : !!token.trim() && (provider !== "bitbucket" && provider !== "generic" ? true : !!username.trim())) &&
    (provider === "github" || provider === "gitlab" || provider === "bitbucket" || !!server.trim());

  return (
    <Modal
      title="Accounts"
      icon={<User size={16} />}
      wide
      onClose={() => !loginBusy && closeModal()}
      footer={
        <>
          {adding && accounts.length > 0 ? (
            <button className="btn left" onClick={() => setAdding(false)} disabled={loginBusy}>
              Back
            </button>
          ) : null}
          <button className="btn" onClick={closeModal} disabled={loginBusy}>
            Close
          </button>
          {adding ? (
            loginBusy ? (
              <button className="btn danger" onClick={cancel}>
                Cancel sign-in
              </button>
            ) : (
              <button className="btn primary" disabled={!canStart} onClick={() => void start()}>
                {provider === "generic" ? <LogIn /> : <ProviderMark provider={provider} color="#0b1512" />}{" "}
                {method === "browser"
                  ? provider === "github"
                    ? "Sign in with GitHub"
                    : provider === "gitlab"
                      ? "Sign in with GitLab"
                      : provider === "gitea"
                        ? "Sign in with Gitea"
                        : "Sign in with browser"
                  : provider === "bitbucket"
                    ? "Connect Bitbucket"
                    : "Connect"}
              </button>
            )
          ) : (
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Plus /> Add account
            </button>
          )}
        </>
      }
    >
      {!adding ? (
        <div className="form">
          {accounts.length === 0 ? <div className="muted">No accounts connected.</div> : null}
          <div className="list">
            {accounts.map((a) => (
              <div key={a.id} className="list-item" style={{ cursor: "default" }}>
                <Avatar name={a.displayName || a.username} url={a.avatarUrl} size="large" />
                <ProviderMark provider={a.provider} size={18} />
                <div className="main">
                  <div className="t">
                    {a.displayName || a.username} <span className="muted" style={{ fontWeight: 400 }}>@{a.username}</span>
                  </div>
                  <div className="s">
                    {PROVIDER_LABELS[a.provider]} · {a.host} · {a.authKind === "oauth" ? "OAuth" : a.authKind === "token" ? "token" : "password"}
                  </div>
                </div>
                <button className="btn small" title="Get a new token for this account" disabled={loginBusy} onClick={() => reauthAccount(a)}>
                  <RefreshCw /> Sign in again
                </button>
                <button className="icon-btn" title="Open in browser" onClick={() => void openUrl(a.webBase)}>
                  <ExternalLink />
                </button>
                <button
                  className="icon-btn danger"
                  title="Remove account"
                  onClick={() =>
                    confirmDialog({
                      title: "Remove account",
                      message: `Remove ${a.username} @ ${a.host}? The stored token is deleted from the keychain.`,
                      confirmLabel: "Remove",
                      danger: true,
                      onConfirm: () => void removeAccount(a.id),
                    })
                  }
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
          {progress}
          <div className="muted" style={{ fontSize: 12 }}>
            Accounts are used to authenticate HTTPS push/pull/fetch, Git LFS transfers, and to list your repositories when cloning. Tokens are stored
            in the OS keychain.
          </div>
        </div>
      ) : (
        <div className="form">
          <div className="row-inline">
            <span className="provider-mark">
              <ProviderMark provider={provider} size={22} />
            </span>
            <div className="field" style={{ width: 220 }}>
              <label>Provider</label>
              <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)} disabled={loginBusy}>
                {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Server URL</label>
              <input
                className="input"
                placeholder={provider === "github" ? "https://github.com (or GitHub Enterprise URL)" : "https://git.example.com"}
                value={server}
                onChange={(e) => setServer(e.target.value)}
                disabled={loginBusy}
              />
            </div>
          </div>

          {browserAvailable ? (
            <div className="segmented" style={{ alignSelf: "flex-start" }}>
              <button className={method === "browser" ? "active" : ""} onClick={() => setMethod("browser")} disabled={loginBusy}>
                Sign in with browser (OAuth)
              </button>
              <button className={method === "token" ? "active" : ""} onClick={() => setMethod("token")} disabled={loginBusy}>
                Use a token
              </button>
            </div>
          ) : null}

          {method === "browser" && browserAvailable ? (
            <>
              {clientIdBuiltIn ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  {appInfo?.githubBrowserLogin
                    ? "Opens github.com in your browser; approve VibeGitty there and the sign-in completes by itself. Nothing to configure."
                    : "Signs in with GitHub's device flow: a one-time code is shown here and you confirm it in your browser. Nothing to configure."}
                </div>
              ) : null}
              <div className="field" style={clientIdBuiltIn ? { display: "none" } : undefined}>
                <label>{provider === "github" ? "OAuth App client id" : "OAuth application id"}</label>
                <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={provider === "github" ? "Iv1.… or 20-char client id" : "application id"} disabled={loginBusy} />
                {provider === "github" ? (
                  <div className="hint">
                    Create an OAuth App at{" "}
                    <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/settings/developers"); }}>
                      github.com/settings/developers
                    </a>
                    . With a client secret the sign-in completes in the browser (callback URL <code>{redirectUri}</code>); without one GitHub's{" "}
                    <b>device flow</b> is used, which must be enabled on the app. Both values are remembered in Settings.
                  </div>
                ) : (
                  <div className="hint">
                    Register an OAuth application ({provider === "gitlab" ? "Confidential: off" : "public client"}) with redirect URI{" "}
                    <code>{redirectUri}</code>
                    {provider === "gitlab" ? " and scopes api, read_user" : ""}. PKCE is used, so no client secret is needed.
                  </div>
                )}
              </div>
              {provider === "github" && !clientIdBuiltIn ? (
                <div className="field">
                  <label>OAuth App client secret (optional)</label>
                  <input className="input mono" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="enables browser sign-in" disabled={loginBusy} />
                </div>
              ) : null}
              {progress}
            </>
          ) : (
            <>
              {provider === "bitbucket" || provider === "generic" ? (
                <div className="field">
                  <label>Username</label>
                  <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} disabled={loginBusy} />
                </div>
              ) : null}
              <div className="field">
                <label>{provider === "bitbucket" ? "App password" : provider === "generic" ? "Password / token" : "Personal access token"}</label>
                <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} disabled={loginBusy} onKeyDown={(e) => e.key === "Enter" && canStart && void start()} />
                <div className="hint">
                  <KeyRound size={11} style={{ verticalAlign: "-1px" }} /> {tokenHelp[provider]}
                </div>
              </div>
              {authStatus?.stage === "waiting" ? (
                <div className="progress-inline">
                  <Loader2 className="spin" size={14} /> Verifying…
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
