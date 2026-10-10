import { spawn } from 'node:child_process';
import { chromiumBrowsers, defaultBrowser } from './browsers.ts';

/**
 * Opens Errand like an app, in the user's default browser: its own window (no tabs or address
 * bar) when that browser is Chromium-based, a normal tab when it's Firefox or Safari.
 * The launchers ask for this with ERRAND_OPEN=1.
 */
export function openApp(url: string) {
  const def = defaultBrowser();
  const app = def ? (def.chromium ? def : null) : (chromiumBrowsers()[0] ?? null);
  const [cmd, args] = app
    ? [app.path, [`--app=${url}`]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: !app })
    .on('error', () => console.log(`  Open ${url} in your browser.`))
    .unref();
}
