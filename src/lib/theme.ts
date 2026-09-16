import { useUiStore } from "../store/ui";

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

let currentPref: ThemePref = "dark";
let mql: MediaQueryList | null = null;

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}

/** Apply a theme preference to the document and keep it in sync with the OS when "system". */
export function applyTheme(pref: ThemePref) {
  currentPref = pref;
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  useUiStore.getState().setResolvedTheme(resolved);
  if (!mql && typeof window !== "undefined" && window.matchMedia) {
    mql = window.matchMedia("(prefers-color-scheme: light)");
    mql.addEventListener("change", () => {
      if (currentPref === "system") applyTheme("system");
    });
  }
}
