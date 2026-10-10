import { get, run } from './db.ts';
import { agentBrowser } from './browsers.ts';

export interface Settings {
  userName: string;
  location: { name: string; lat: number; lon: number } | null;
  timezone: string;
  models: {
    chat: string; // "providerId:modelId"
    handoff: string; // vision-capable model recommended
    utility: string; // cheap model for memory extraction, titles, action buttons
  };
  handoff: {
    browserChannel: 'msedge' | 'chrome' | 'chromium' | 'custom' | 'remote';
    executablePath: string;
    cdpUrl: string; // remote browser ("cloud computer") over the Chrome DevTools Protocol
    extraArgs: string[];
    headless: boolean;
    maxConcurrent: number;
    maxSteps: number;
    useVision: boolean;
  };
  /** email: notice things in new mail (CI failures, orders, bills, trips, applications) and keep trackers. */
  proactive: { enabled: boolean; intervalMinutes: number; email: boolean };
  search: { provider: 'duckduckgo' | 'google' | 'brave' | 'tavily' | 'searxng'; apiKey: string; url: string };
  /** Your own Google OAuth client for "Connect Google" (secret sealed at rest). */
  google: { clientId: string; clientSecret: string };
  /** Your own Microsoft app registration, if Errand's built-in one isn't used (public client: no secret). */
  microsoft: { clientId: string };
  /** Base URL Errand is reached at (used for OAuth redirects). */
  publicUrl: string;
  calendars: { name: string; url: string }[];
  files: { roots: string[] };
  vault: { autoLockMinutes: number };
  voice: { speakReplies: boolean };
  notifications: { ntfyUrl: string };
  /** Ask GitHub every few hours whether a newer Errand is out. */
  updates: { check: boolean };
  /** Off by default. When on, the assistant may run shell commands, each approved by the user. */
  computer: { allowCommands: boolean };
  customInstructions: string;
}

export const defaultSettings: Settings = {
  userName: '',
  location: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  models: { chat: '', handoff: '', utility: '' },
  handoff: {
    // Env overrides let the Docker image ship with its own browser and virtual display. Otherwise the
    // agent drives the user's own default browser when it's Chromium-based (Chrome, Edge, Brave…).
    ...(process.env.ERRAND_BROWSER_CHANNEL || process.env.ERRAND_BROWSER_PATH
      ? {
          browserChannel: (process.env.ERRAND_BROWSER_CHANNEL as any) || 'custom',
          executablePath: process.env.ERRAND_BROWSER_PATH ?? '',
        }
      : agentBrowser()),
    cdpUrl: process.env.ERRAND_CDP_URL ?? '',
    extraArgs: (process.env.ERRAND_BROWSER_ARGS ?? '').split(' ').filter(Boolean),
    headless: process.env.ERRAND_HEADLESS ? process.env.ERRAND_HEADLESS !== '0' : true,
    maxConcurrent: 6,
    maxSteps: 40,
    useVision: true,
  },
  proactive: { enabled: true, intervalMinutes: 120, email: true },
  search: { provider: 'duckduckgo', apiKey: '', url: '' },
  google: { clientId: '', clientSecret: '' },
  microsoft: { clientId: '' },
  publicUrl: '',
  calendars: [],
  files: { roots: [] },
  vault: { autoLockMinutes: 30 },
  voice: { speakReplies: false },
  notifications: { ntfyUrl: '' },
  updates: { check: true },
  computer: { allowCommands: false },
  customInstructions: '',
};

function merge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = merge((base as any)[k], over[k]);
  return out;
}

export function getSettings(): Settings {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'app');
  return merge(defaultSettings, row ? JSON.parse(row.value) : {});
}

/** True for a time zone the runtime understands ("Asia/Kolkata"); false for '' or a typo. */
const validTimeZone = (tz: string) => {
  try {
    return !!tz && !!new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return false;
  }
};

export function saveSettings(next: Partial<Settings>): Settings {
  // A blank or unknown time zone would break every date shown to the model, so it keeps the old one.
  if (next.timezone !== undefined && !validTimeZone(next.timezone)) {
    const { timezone: _ignored, ...rest } = next;
    next = rest;
  }
  const merged = merge(getSettings(), next);
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'app', JSON.stringify(merged));
  return merged;
}

export function getKV(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}
export function setKV(key: string, value: string) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
