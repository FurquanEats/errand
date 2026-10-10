import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The user's default browser, so Errand opens where they expect and the browser agent uses the
 * same browser they already know. Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Arc…)
 * can show Errand as an app window and can be driven by the agent; others (Firefox, Safari) can't.
 */

export interface Browser {
  name: string;
  path: string; // executable, or the app name on macOS
  chromium: boolean;
}

const CHROMIUM = /chrome|msedge|edge|brave|vivaldi|chromium|thorium|arc|yandex|opera/i;
const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true });
  } catch {
    return '';
  }
};

function windowsDefault(): Browser | null {
  const progId = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']).match(
    /ProgId\s+REG_SZ\s+(\S+)/,
  )?.[1];
  if (!progId) return null;
  const command = run('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']).match(/REG_SZ\s+(.+)/)?.[1] ?? '';
  const exe = command.match(/^"([^"]+)"/)?.[1] ?? command.split(' ')[0];
  if (!exe || !fs.existsSync(exe)) return null;
  const name = path.basename(exe, '.exe');
  return { name, path: exe, chromium: CHROMIUM.test(name) && !/launcher/i.test(name) };
}

const MAC_APPS: Record<string, string> = {
  'com.google.chrome': 'Google Chrome',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.browser': 'Brave Browser',
  'com.vivaldi.vivaldi': 'Vivaldi',
  'company.thebrowser.browser': 'Arc',
  'org.chromium.chromium': 'Chromium',
};

function macDefault(): Browser | null {
  const handlers = run('defaults', [
    'read',
    path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure'),
    'LSHandlers',
  ]);
  const block = handlers.split('}').find((b) => /LSHandlerURLScheme = https;/.test(b));
  const id = block?.match(/LSHandlerRoleAll = "?([\w.-]+)"?;/)?.[1]?.toLowerCase();
  if (!id) return null;
  const app = MAC_APPS[id];
  const exe = app && `/Applications/${app}.app/Contents/MacOS/${app}`;
  return exe && fs.existsSync(exe) ? { name: app, path: exe, chromium: true } : { name: id, path: '', chromium: false };
}

function linuxDefault(): Browser | null {
  const desktop = run('xdg-settings', ['get', 'default-web-browser']).trim();
  if (!desktop) return null;
  const bin = desktop.replace(/\.desktop$/, '').replace(/^com\.|^org\./, '');
  const exe = run('sh', ['-c', `command -v ${JSON.stringify(bin)}`]).trim();
  return { name: bin, path: exe, chromium: CHROMIUM.test(bin) && !!exe };
}

let cached: Browser | null | undefined;
export function defaultBrowser(): Browser | null {
  if (cached === undefined)
    cached =
      process.platform === 'win32' ? windowsDefault() : process.platform === 'darwin' ? macDefault() : process.platform === 'linux' ? linuxDefault() : null;
  return cached;
}

/** Installed Chromium-based browsers, in the order Errand prefers when the default isn't one. */
export function chromiumBrowsers(): Browser[] {
  const env = process.env;
  const list =
    process.platform === 'win32'
      ? [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].flatMap((dir) =>
          dir
            ? [
                ['Chrome', 'Google/Chrome/Application/chrome.exe'],
                ['Edge', 'Microsoft/Edge/Application/msedge.exe'],
                ['Brave', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
              ].map(([name, p]) => ({ name, path: path.join(dir, p), chromium: true }))
            : [],
        )
      : process.platform === 'darwin'
        ? Object.values(MAC_APPS).map((n) => ({ name: n, path: `/Applications/${n}.app/Contents/MacOS/${n}`, chromium: true }))
        : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((n) => ({ name: n, path: `/usr/bin/${n}`, chromium: true }));
  const found = list.filter((b) => fs.existsSync(b.path));
  const def = defaultBrowser();
  return def?.chromium ? [def, ...found.filter((b) => b.path.toLowerCase() !== def.path.toLowerCase())] : found;
}

/** What the browser agent should drive by default: the user's own browser when it can be driven. */
export function agentBrowser(): { browserChannel: 'msedge' | 'chrome' | 'custom'; executablePath: string } {
  const b = chromiumBrowsers()[0];
  if (!b) return { browserChannel: process.platform === 'win32' ? 'msedge' : 'chrome', executablePath: '' };
  if (/msedge|edge/i.test(b.path)) return { browserChannel: 'msedge', executablePath: '' };
  if (/chrome\.exe$|Google Chrome$|google-chrome$/i.test(b.path)) return { browserChannel: 'chrome', executablePath: '' };
  return { browserChannel: 'custom', executablePath: b.path };
}
