import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { DATA_DIR } from '../config.ts';
import { getSettings } from '../settings.ts';
import { isOwnOrigin } from '../security.ts';

/**
 * One persistent browser profile shared by all handoff tasks, so a site you log into once
 * (by watching the agent, or with "Show browser window" on) stays logged in.
 */

let ctx: BrowserContext | null = null;
let launching: Promise<BrowserContext> | null = null;
let launchedHeadless: boolean | null = null;
let active = 0;
const queue: (() => void)[] = [];

export async function getContext(): Promise<BrowserContext> {
  const s = getSettings().handoff;
  if (ctx && launchedHeadless !== s.headless && active === 0) await closeBrowser();
  if (ctx) return ctx;
  if (launching) return launching;
  launching = (async () => {
    if (s.browserChannel === 'remote') return connectRemote(s.cdpUrl);
    const opts: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: s.headless,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: getSettings().timezone || undefined,
      args: ['--disable-blink-features=AutomationControlled', ...s.extraArgs],
    };
    if (s.browserChannel === 'custom' && s.executablePath) opts.executablePath = s.executablePath;
    else if (s.browserChannel !== 'chromium') opts.channel = s.browserChannel;
    try {
      const c = await chromium.launchPersistentContext(path.join(DATA_DIR, 'browser-profile'), opts);
      c.on('close', () => {
        ctx = null;
      });
      // Pages in the agent's browser can never load Errand's own API (it holds your data).
      await c.route(
        (url) => isOwnOrigin(url.toString()),
        (route) => route.abort('blockedbyclient'),
      );
      ctx = c;
      launchedHeadless = s.headless;
      return c;
    } catch (err) {
      throw new Error(
        `Could not start the browser (${s.browserChannel}). Install Chrome or Edge, pick another browser in Settings → Handoff, ` +
          `or run "npx playwright install chromium" and choose Chromium. Details: ${(err as Error).message.split('\n')[0]}`,
      );
    } finally {
      launching = null;
    }
  })();
  return launching;
}

/**
 * A remote browser: a hosted provider (Browserbase, Browserless, Steel, Hyperbrowser…) or your own
 * always-on machine exposing Chrome's DevTools port. This is Errand's "own computer in the cloud".
 */
async function connectRemote(cdpUrl: string): Promise<BrowserContext> {
  if (!cdpUrl) throw new Error('Remote browser selected but no CDP URL is set (Settings → Handoff).');
  try {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30000 });
    const c = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 800 } }));
    browser.on('disconnected', () => {
      ctx = null;
    });
    await c.route(
      (url) => isOwnOrigin(url.toString()),
      (route) => route.abort('blockedbyclient'),
    );
    ctx = c;
    launchedHeadless = getSettings().handoff.headless;
    return c;
  } catch (err) {
    throw new Error(`Could not connect to the remote browser: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    launching = null;
  }
}

export async function closeBrowser() {
  const c = ctx;
  ctx = null;
  await c?.close().catch(() => {});
}

/** Limit concurrent tasks (Hark-style "up to 6 browsers at once" by default). */
export async function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  const max = Math.max(1, getSettings().handoff.maxConcurrent);
  if (active >= max) {
    await new Promise<void>((resolve, reject) => {
      queue.push(resolve);
      signal?.addEventListener('abort', () => reject(new Error('Cancelled')));
    });
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    queue.shift()?.();
  };
}
