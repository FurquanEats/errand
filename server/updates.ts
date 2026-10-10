import { readFileSync } from 'node:fs';
import { get } from './db.ts';
import { getKV, getSettings, setKV } from './settings.ts';
import { canSelfUpdate } from './lifecycle.ts';

/** This install's version, and the latest release on GitHub (checked at most every six hours). */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const REPO = 'FurquanEats/errand';
let checked = 0;
let latest: string | null = null;

export async function versionInfo(force = false) {
  if ((getSettings().updates.check || force) && (force || Date.now() - checked > 6 * 3600_000)) {
    checked = Date.now();
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '') || latest;
    } catch {
      /* offline: try again next time */
    }
  }
  return {
    version: VERSION,
    latest,
    update: !!latest && newer(latest, VERSION),
    releases: `https://github.com/${REPO}/releases/latest`,
    selfUpdate: canSelfUpdate(),
  };
}

/**
 * After an update, say what's new once in the main chat, using the highlights at the top of
 * CHANGELOG.md. A fresh install just records its version.
 */
export function announceUpdate(post: (markdown: string) => void) {
  const seen = getKV('version.seen');
  setKV('version.seen', VERSION);
  // Installs from before version.seen existed have no record, but they do have messages.
  if (seen === VERSION || (!seen && !get('SELECT 1 AS x FROM messages LIMIT 1'))) return;
  let highlights: string[] = [];
  try {
    const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const whole = log.split(/^## /m).find((s) => s.startsWith(VERSION)) ?? '';
    // Someone updating wants what changed, not the overview at the top of a big release.
    const section = whole.split(/^\*\*New since.*$/m)[1] ?? whole;
    highlights = [...section.matchAll(/^- \*\*(.+?)\.?\*\*/gm)]
      .map((m) => m[1])
      .filter((t) => t !== 'Fixes')
      .slice(0, 5);
  } catch {
    /* no changelog in this install */
  }
  post(
    `Errand was updated to **${VERSION}**.${highlights.length ? ` New: ${highlights.join(' · ')}.` : ''} ` +
      `[See everything new](https://github.com/${REPO}/blob/main/CHANGELOG.md)`,
  );
}

/** True if version a is newer than b ("0.1.10" > "0.1.9"). */
export function newer(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
