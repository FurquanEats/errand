import fs from 'node:fs';
import path from 'node:path';
import { all, db } from './db.ts';
import { DATA_DIR } from './config.ts';
import { closeBrowser } from './handoff/browser.ts';
import { lock } from './vault.ts';
import { publish } from './bus.ts';

/**
 * "Your data is yours": export everything readable as JSON, or delete it all.
 * Secrets stay encrypted in exports (vault items and tokens are omitted).
 */

const EXPORT_TABLES = ['projects', 'project_tasks', 'conversations', 'messages', 'memories', 'handoffs', 'actions', 'panels', 'routines', 'tracked'];

export function exportAllData() {
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), app: 'errand' };
  for (const t of EXPORT_TABLES) out[t] = all(`SELECT * FROM ${t}`);
  out.vault = all('SELECT id, kind, label, domain, hint, created_at FROM vault_items');
  out.emailAccounts = all('SELECT id, kind, address, display_name, created_at FROM email_accounts');
  return out;
}

/** Permanently delete all data: database rows, vault, files, browser profile and sessions. */
export async function deleteAllData() {
  lock();
  await closeBrowser();
  const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
  db.exec('PRAGMA foreign_keys = ON; VACUUM;');
  for (const dir of ['files', 'handoff-frames', 'browser-profile']) fs.rmSync(path.join(DATA_DIR, dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'handoff-frames'), { recursive: true });
  publish({ type: 'settings.updated' });
  publish({ type: 'conversations.updated' });
}
