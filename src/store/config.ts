import { create } from "zustand";
import { api, errorMessage } from "../api";
import type { Account, AppConfig, AppInfo, AuthStatus, Settings } from "../types";
import { toast } from "./ui";

interface ConfigStore {
  config: AppConfig | null;
  appInfo: AppInfo | null;
  setAppInfo: (i: AppInfo) => void;
  authStatus: AuthStatus | null;
  loginBusy: boolean;
  setConfig: (c: AppConfig) => void;
  reload: () => Promise<void>;
  saveSettings: (s: Settings) => Promise<boolean>;
  setAuthStatus: (s: AuthStatus | null) => void;
  setLoginBusy: (b: boolean) => void;
  removeAccount: (id: string) => Promise<void>;
  accounts: () => Account[];
  settings: () => Settings | null;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  appInfo: null,
  setAppInfo: (appInfo) => set({ appInfo }),
  authStatus: null,
  loginBusy: false,
  setConfig: (config) => set({ config }),
  reload: async () => {
    try {
      set({ config: await api.getConfig() });
    } catch (e) {
      toast("error", errorMessage(e));
    }
  },
  saveSettings: async (settings) => {
    try {
      await api.saveSettings(settings);
      await get().reload();
      return true;
    } catch (e) {
      toast("error", errorMessage(e));
      return false;
    }
  },
  setAuthStatus: (authStatus) => set({ authStatus }),
  setLoginBusy: (loginBusy) => set({ loginBusy }),
  removeAccount: async (id) => {
    try {
      await api.removeAccount(id);
      await get().reload();
    } catch (e) {
      toast("error", errorMessage(e));
    }
  },
  accounts: () => get().config?.accounts ?? [],
  settings: () => get().config?.settings ?? null,
}));
