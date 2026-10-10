import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.ts';

export const db = new DatabaseSync(path.join(DATA_DIR, 'errand.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  base_url TEXT, api_key TEXT, models TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '📁', archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, due TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, conversation_id TEXT, goal TEXT NOT NULL, status TEXT NOT NULL,
  result TEXT, steps TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '✨', priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'proactive',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, request TEXT NOT NULL, html TEXT NOT NULL,
  data_prompt TEXT NOT NULL, data TEXT, error TEXT, refresh_minutes INTEGER NOT NULL DEFAULT 60,
  size TEXT NOT NULL DEFAULT 'md', position INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_accounts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, address TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}', secret TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, last_conversation TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, message_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, merchant TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '', amount REAL, currency TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_kind ON signals(kind, at);

CREATE TABLE IF NOT EXISTS tracked (
  id TEXT PRIMARY KEY, tracker TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '', amount TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, changed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tracker, key)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}', url TEXT,
  headers TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
`);

// Lightweight migrations for columns added after first release.
for (const sql of [
  'ALTER TABLE mcp_servers ADD COLUMN approval INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'",
  'ALTER TABLE actions ADD COLUMN key TEXT',
]) {
  try {
    db.exec(sql);
  } catch {
    /* already applied */
  }
}

export const id = () => crypto.randomUUID();
export const now = () => Date.now();

type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

/** Insert a row from a plain object. */
export function insert(table: string, row: Row) {
  const keys = Object.keys(row);
  run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}

/** Update whitelisted columns of a row by id. Unknown keys are ignored. */
export function patch(table: string, rowId: string, changes: Row, allowed: string[]) {
  const keys = Object.keys(changes).filter((k) => allowed.includes(k) && changes[k] !== undefined);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => changes[k]), rowId);
}

export function parseJSON<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
