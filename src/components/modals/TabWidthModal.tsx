import { useState } from "react";
import { IndentIncrease, X } from "lucide-react";
import { Modal } from "../Modal";
import { closeModal } from "../../store/ui";
import { useConfigStore } from "../../store/config";
import { useActiveRepo } from "../../store/repos";
import { TAB_DEFAULT } from "../../lib/tabs";
import type { TabSetting } from "../../types";

const CHOICES: TabSetting[] = ["auto", 2, 4, 8];
type Choice = TabSetting | "inherit";

/** Tab width for the repository (`dir` empty) or for one folder and everything below it. */
export function TabWidthModal({ dir }: { dir: string }) {
  const repo = useActiveRepo();
  const prefs = useConfigStore((s) => (repo ? s.config?.repoPrefs?.[repo.path] : undefined));
  const updateRepoPrefs = useConfigStore((s) => s.updateRepoPrefs);
  const isRepo = dir === "";
  const current: Choice = isRepo ? (prefs?.tabSize ?? "auto") : (prefs?.tabOverrides?.[dir] ?? "inherit");
  const [value, setValue] = useState<Choice>(current);
  const overrides = Object.entries(prefs?.tabOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const label = (v: Choice) => (v === "inherit" ? "Inherit" : v === "auto" ? "Auto" : `${v}`);

  const save = async () => {
    if (!repo) return;
    await updateRepoPrefs(repo.path, (p) => {
      if (isRepo) return { ...p, tabSize: value === "inherit" ? "auto" : value };
      const o = { ...(p.tabOverrides ?? {}) };
      if (value === "inherit") delete o[dir];
      else o[dir] = value;
      return { ...p, tabOverrides: o };
    });
    closeModal();
  };
  const removeOverride = (d: string) => {
    if (!repo) return;
    void updateRepoPrefs(repo.path, (p) => {
      const o = { ...(p.tabOverrides ?? {}) };
      delete o[d];
      return { ...p, tabOverrides: o };
    });
  };

  return (
    <Modal
      title="Tab width"
      icon={<IndentIncrease size={16} />}
      footer={
        <>
          <button className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn primary" disabled={!repo} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label>{isRepo ? "Repository default" : `Folder ${dir} and everything below it`}</label>
          <div className="segmented" style={{ alignSelf: "flex-start" }}>
            {(isRepo ? CHOICES : (["inherit", ...CHOICES] as Choice[])).map((v) => (
              <button key={String(v)} className={value === v ? "active" : ""} onClick={() => setValue(v)}>
                {label(v)}
              </button>
            ))}
          </div>
          <div className="hint">
            Auto follows the repository\u2019s .editorconfig (tab_width, else indent_size) and falls back to {TAB_DEFAULT} columns. A folder
            setting wins over the repository default, and the nearest folder wins. The text itself is never changed; only how wide a tab is drawn.
          </div>
        </div>
        {overrides.length ? (
          <div className="field">
            <label>Folder overrides in this repository</label>
            <div className="list">
              {overrides.map(([d, v]) => (
                <div key={d} className="list-item" style={{ cursor: "default" }}>
                  <div className="main">
                    <div className="t">{d}</div>
                    <div className="s">{v === "auto" ? "Auto (.editorconfig)" : `${v} columns`}</div>
                  </div>
                  <button className="icon-btn danger" title="Remove this override" onClick={() => removeOverride(d)}>
                    <X />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
