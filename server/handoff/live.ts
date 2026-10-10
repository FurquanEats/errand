import type { CDPSession, Page } from 'playwright-core';

/**
 * The live view of a browser task: a screencast of its tab that runs only while someone is
 * watching, and the input path for taking over with your own mouse and keyboard.
 */

export interface LiveFrame {
  image: string; // base64 JPEG
  url: string;
  width: number; // CSS pixels of the page the frame shows
  height: number;
}

export type InputEvent =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
  | { type: 'text'; text: string };

type Watcher = (f: LiveFrame) => void;

interface Session {
  page: Page | null;
  cdp: CDPSession | null;
  starting: boolean;
  watchers: Set<Watcher>;
  last: LiveFrame | null;
  sentAt: number;
  pending: LiveFrame | null;
  timer: NodeJS.Timeout | null;
}

const MIN_GAP = 70; // at most ~14 frames a second reach the screen
const sessions = new Map<string, Session>();

const session = (id: string) => {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { page: null, cdp: null, starting: false, watchers: new Set(), last: null, sentAt: 0, pending: null, timer: null }));
  return s;
};

function deliver(s: Session, f: LiveFrame) {
  s.last = f;
  const wait = MIN_GAP - (Date.now() - s.sentAt);
  if (wait <= 0) {
    s.sentAt = Date.now();
    s.watchers.forEach((w) => w(f));
    return;
  }
  // Keep only the newest frame while throttled.
  s.pending = f;
  s.timer ??= setTimeout(() => {
    s.timer = null;
    const next = s.pending;
    s.pending = null;
    if (next) deliver(s, next);
  }, wait);
}

async function start(s: Session) {
  const page = s.page;
  if (!page || page.isClosed() || s.cdp || s.starting || !s.watchers.size) return;
  s.starting = true;
  try {
    const cdp = await page.context().newCDPSession(page);
    s.cdp = cdp;
    cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (s.page !== page) return;
      deliver(s, { image: e.data, url: page.url(), width: e.metadata.deviceWidth, height: e.metadata.deviceHeight });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1000 });
  } catch {
    // Not a Chromium page (or it closed): fall back to one still.
    s.cdp = null;
    await still(s);
  } finally {
    s.starting = false;
  }
  // Everyone left while starting, or the task moved to another tab: follow it.
  if (!s.watchers.size) await stop(s);
  else if (s.page !== page) await stop(s).then(() => start(s));
}

async function stop(s: Session) {
  const cdp = s.cdp;
  s.cdp = null;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.pending = null;
  await cdp?.send('Page.stopScreencast').catch(() => {});
  await cdp?.detach().catch(() => {});
}

async function still(s: Session) {
  const page = s.page;
  if (!page || page.isClosed()) return;
  const buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 3000 }).catch(() => null);
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  if (buf) deliver(s, { image: buf.toString('base64'), url: page.url(), width: size.width, height: size.height });
}

/** The agent calls this whenever its task switches tabs (a popup, say). */
export async function attach(id: string, page: Page) {
  const s = session(id);
  if (s.page === page) return;
  await stop(s);
  s.page = page;
  page.once('close', () => {
    if (s.page === page) s.page = null;
  });
  await start(s);
}

/** The task ended: watchers keep the last frame; the session goes once nobody is watching. */
export async function detach(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  await stop(s);
  s.page = null;
  if (!s.watchers.size) sessions.delete(id);
}

/** The latest frame, for saving the final screen of a task. */
export async function snapshotFrame(id: string): Promise<LiveFrame | null> {
  const s = sessions.get(id);
  if (!s) return null;
  if (!s.cdp) await still(s);
  return s.last;
}

/** Watch a task's screen. Returns a function that stops watching. */
export function watch(id: string, fn: Watcher): () => void {
  const s = session(id);
  s.watchers.add(fn);
  if (s.last) fn(s.last);
  void start(s);
  return () => {
    s.watchers.delete(fn);
    if (s.watchers.size) return;
    void stop(s);
    if (!s.page) sessions.delete(id);
  };
}

const KEYS: Record<string, string> = { ' ': 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

/** Input from someone who took over. Coordinates are 0–1 across the page, so any screen size works. */
export async function input(id: string, e: InputEvent) {
  const page = sessions.get(id)?.page;
  if (!page || page.isClosed()) throw new Error('This task’s browser is closed');
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const at = (x: number, y: number) => [Math.max(0, Math.min(1, x)) * size.width, Math.max(0, Math.min(1, y)) * size.height] as const;
  switch (e.type) {
    case 'click':
      return page.mouse.click(...at(e.x, e.y), { button: e.button ?? 'left', clickCount: Math.min(3, e.count ?? 1) });
    case 'move':
      return page.mouse.move(...at(e.x, e.y));
    case 'down':
    case 'up':
      await page.mouse.move(...at(e.x, e.y));
      return e.type === 'down' ? page.mouse.down({ button: e.button ?? 'left' }) : page.mouse.up({ button: e.button ?? 'left' });
    case 'wheel':
      await page.mouse.move(...at(e.x, e.y));
      return page.mouse.wheel(Math.max(-4000, Math.min(4000, e.dx)), Math.max(-4000, Math.min(4000, e.dy)));
    case 'text':
      return page.keyboard.insertText(String(e.text).slice(0, 10_000));
    case 'key': {
      const key = KEYS[e.key] ?? e.key;
      if (!/^[\w\s\p{P}\p{S}]{1,24}$/u.test(key)) return;
      const mods = [e.ctrl && 'Control', e.alt && 'Alt', e.meta && 'Meta', e.shift && key.length > 1 && 'Shift'].filter(Boolean);
      return page.keyboard.press([...mods, key].join('+'));
    }
  }
}
