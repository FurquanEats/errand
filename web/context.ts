import { createContext, useContext } from 'react';

export interface AppSettings {
  userName: string;
  location: { name: string; lat: number; lon: number } | null;
  timezone: string;
  models: { chat: string; handoff: string; utility: string };
  handoff: {
    browserChannel: string;
    executablePath: string;
    cdpUrl: string;
    extraArgs: string[];
    headless: boolean;
    maxConcurrent: number;
    maxSteps: number;
    useVision: boolean;
  };
  proactive: { enabled: boolean; intervalMinutes: number; email: boolean };
  updates: { check: boolean };
  search: { provider: string; apiKey: string; url: string; hasApiKey?: boolean };
  google: { clientId: string; clientSecret: string; hasClientSecret?: boolean; redirectUri?: string };
  publicUrl: string;
  calendars: { name: string; url: string }[];
  files: { roots: string[] };
  vault: { autoLockMinutes: number };
  voice: { speakReplies: boolean };
  notifications: { ntfyUrl: string };
  computer: { allowCommands: boolean };
  customInstructions: string;
  microsoft?: { clientId: string; ready: boolean; redirectUri: string };
}

export interface AppContext {
  settings: AppSettings | null;
  reloadSettings: () => Promise<void>;
  toast: (msg: string) => void;
  /** True on a phone using Settings → Use on your phone: sign-ins must happen on the computer. */
  phone?: boolean;
}

export const Ctx = createContext<AppContext>({ settings: null, reloadSettings: async () => {}, toast: () => {} });
export const useApp = () => useContext(Ctx);
