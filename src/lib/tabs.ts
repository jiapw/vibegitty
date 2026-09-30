import type { RepoPrefs, TabSetting } from "../types";

/** Columns per tab when neither the repository nor .editorconfig says otherwise. */
export const TAB_DEFAULT = 4;

export interface TabResolution {
  value: TabSetting;
  /** Where the value comes from: a folder override or the repository default. */
  scope: "repo" | "folder";
  dir: string;
}

/** The setting that applies to a file: the nearest folder override, else the repository default. */
export function resolveTabSetting(prefs: RepoPrefs | undefined, filePath: string): TabResolution {
  const overrides = prefs?.tabOverrides ?? {};
  let dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  while (dir) {
    const v = overrides[dir];
    if (v !== undefined) return { value: v, scope: "folder", dir };
    const i = dir.lastIndexOf("/");
    dir = i < 0 ? "" : dir.slice(0, i);
  }
  return { value: prefs?.tabSize ?? "auto", scope: "repo", dir: "" };
}

/** Columns to render, given the setting and the .editorconfig answer (when known). */
export function effectiveTabSize(res: TabResolution, auto: number | null): number {
  return res.value === "auto" ? (auto ?? TAB_DEFAULT) : res.value;
}
