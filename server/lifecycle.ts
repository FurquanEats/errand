import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { closeBrowser } from './handoff/browser.ts';

/**
 * Quitting and updating Errand. While it shuts down, /api/status answers 503 so a launcher started
 * at that moment waits for the port to free up instead of mistaking it for a running Errand.
 */
let quitting = false;
export const isQuitting = () => quitting;

export function quitSoon(delayMs: number) {
  quitting = true;
  setTimeout(() => void closeBrowser().finally(() => process.exit(0)), delayMs);
}

/** Errand.exe on Windows sets ERRAND_LAUNCHER to its own path. */
const launcher = () => {
  const exe = process.env.ERRAND_LAUNCHER;
  return exe && fs.existsSync(exe) ? exe : null;
};

const UNIX_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/FurquanEats/errand/main/scripts/install.sh | bash';

/** Whether "update Errand" can run from chat on this install. */
export const canSelfUpdate = () => (process.platform === 'win32' ? !!launcher() : !!process.env.ERRAND_HOME);

/**
 * Starts the installer, which quits this Errand, installs the latest version and opens it again.
 * On Windows Errand.exe shows the installer's progress; elsewhere it runs quietly into update.log.
 */
export function startUpdate(): boolean {
  if (process.platform === 'win32') {
    const exe = launcher();
    if (!exe) return false;
    spawn(exe, ['--update'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const home = process.env.ERRAND_HOME;
  if (!home) return false;
  const log = fs.openSync(path.join(home, 'update.log'), 'w');
  spawn('bash', ['-c', UNIX_INSTALL], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ERRAND_HOME: home } }).unref();
  return true;
}

// ── Start at login ──────────────────────────────────────────────────────────
// Windows: the same HKCU Run value the tray's "Start with Windows" uses. Mac: a LaunchAgent.
// Linux: an XDG autostart entry. All start Errand in the background, without opening a window.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const home = () => process.env.HOME ?? '';
const macAgent = () => path.join(home(), 'Library', 'LaunchAgents', 'in.zovle.errand.plist');
const linuxAutostart = () => path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'autostart', 'errand.desktop');
const unixLauncher = () => {
  const root = process.env.ERRAND_HOME;
  return root && fs.existsSync(path.join(root, 'errand')) ? path.join(root, 'errand') : null;
};
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Whether this install can start itself at login (installed with the installer, not run from source). */
export const canStartAtLogin = () => (process.platform === 'win32' ? !!launcher() : !!unixLauncher());

export function startsAtLogin(): boolean {
  if (process.platform === 'win32') {
    const exe = launcher();
    if (!exe) return false;
    try {
      const out = execFileSync('reg', ['query', RUN_KEY, '/v', 'Errand'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      return out.toLowerCase().includes(exe.toLowerCase());
    } catch {
      return false;
    }
  }
  return fs.existsSync(process.platform === 'darwin' ? macAgent() : linuxAutostart());
}

export function setStartsAtLogin(on: boolean): boolean {
  if (!canStartAtLogin()) return false;
  if (process.platform === 'win32') {
    const args = on ? ['add', RUN_KEY, '/v', 'Errand', '/t', 'REG_SZ', '/d', `"${launcher()}" --background`, '/f'] : ['delete', RUN_KEY, '/v', 'Errand', '/f'];
    try {
      execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
    } catch {
      if (on) return false; // deleting a value that isn't there is fine
    }
    return true;
  }
  const file = process.platform === 'darwin' ? macAgent() : linuxAutostart();
  if (!on) {
    fs.rmSync(file, { force: true });
    return true;
  }
  const exe = unixLauncher()!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    process.platform === 'darwin'
      ? `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>in.zovle.errand</string>
<key>ProgramArguments</key><array><string>${xml(exe)}</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
<key>AbandonProcessGroup</key><true/>
</dict></plist>
`
      : `[Desktop Entry]
Type=Application
Name=Errand
Comment=Starts Errand in the background
Exec="${exe}" --background
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
  return true;
}
