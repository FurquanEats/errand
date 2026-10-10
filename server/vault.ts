import crypto from 'node:crypto';
import { all, get, id, insert, now, patch, run } from './db.ts';
import { decrypt, deriveKey, encrypt } from './crypto.ts';
import { getKV, getSettings, setKV } from './settings.ts';
import { publish } from './bus.ts';

/**
 * The vault holds logins, cards and identity details, encrypted with a key derived from a
 * passphrase only you know (scrypt + AES-256-GCM). The key lives in memory only while unlocked.
 *
 * Models never see secret values. They see tokens such as {{vault:ab12cd34.password}} and the
 * browser agent swaps the real value in at the moment it types into a field.
 */

export type VaultKind = 'login' | 'card' | 'identity' | 'note' | 'api_key';

export const VAULT_FIELDS: Record<VaultKind, string[]> = {
  login: ['username', 'password', 'totp_note'],
  card: ['cardholder', 'number', 'expiry_month', 'expiry_year', 'cvc', 'billing_zip'],
  identity: ['full_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'date_of_birth'],
  note: ['text'],
  // header defaults to Authorization: Bearer <key>; base_url limits where the key may be sent
  api_key: ['key', 'base_url', 'header'],
};

let key: Buffer | null = null;
let lockTimer: NodeJS.Timeout | null = null;

function touch() {
  if (lockTimer) clearTimeout(lockTimer);
  const minutes = getSettings().vault.autoLockMinutes;
  if (minutes > 0) lockTimer = setTimeout(lock, minutes * 60_000);
}

export const isInitialized = () => !!getKV('vault.salt');
export const isUnlocked = () => !!key;

export function status() {
  return { initialized: isInitialized(), unlocked: isUnlocked() };
}

export function setup(passphrase: string) {
  if (isInitialized()) throw new Error('Vault already set up');
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters');
  const salt = crypto.randomBytes(16);
  const k = deriveKey(passphrase, salt);
  setKV('vault.salt', salt.toString('base64'));
  setKV('vault.check', encrypt('errand-vault-ok', k));
  key = k;
  touch();
  publish({ type: 'vault.updated' });
}

export function unlock(passphrase: string) {
  const salt = getKV('vault.salt');
  const check = getKV('vault.check');
  if (!salt || !check) throw new Error('Vault not set up');
  const k = deriveKey(passphrase, Buffer.from(salt, 'base64'));
  try {
    if (decrypt(check, k) !== 'errand-vault-ok') throw new Error();
  } catch {
    throw new Error('Wrong passphrase');
  }
  key = k;
  touch();
  publish({ type: 'vault.updated' });
}

export function lock() {
  key = null;
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = null;
  publish({ type: 'vault.updated' });
}

function requireKey(): Buffer {
  if (!key) throw new Error('Vault is locked. Unlock it in the Vault tab.');
  touch();
  return key;
}

interface VaultRow {
  id: string;
  kind: VaultKind;
  label: string;
  domain: string;
  hint: string;
  secret: string;
  created_at: number;
  updated_at: number;
}

/** Public metadata only: safe to show in UI lists and to models. */
export function listItems() {
  return all<VaultRow>('SELECT * FROM vault_items ORDER BY label').map(({ secret: _s, ...rest }) => ({
    ...rest,
    fields: VAULT_FIELDS[rest.kind] ?? [],
  }));
}

function hintFor(kind: VaultKind, fields: Record<string, string>) {
  if (kind === 'login') return fields.username ?? '';
  if (kind === 'card' && fields.number) return `•••• ${fields.number.replace(/\s/g, '').slice(-4)}`;
  if (kind === 'identity') return fields.full_name ?? '';
  if (kind === 'api_key') return fields.base_url ?? '';
  return '';
}

export function addItem(input: { kind: VaultKind; label: string; domain?: string; fields: Record<string, string> }) {
  const k = requireKey();
  const vid = id();
  insert('vault_items', {
    id: vid,
    kind: input.kind,
    label: input.label,
    domain: normalizeDomain(input.domain ?? ''),
    hint: hintFor(input.kind, input.fields),
    secret: encrypt(JSON.stringify(input.fields), k),
    created_at: now(),
    updated_at: now(),
  });
  publish({ type: 'vault.updated' });
  return vid;
}

/** Fields left blank keep their stored value, so editing never requires revealing secrets. */
/** Save a new login with a generated password (used when the agent signs up for a site). */
export function createLogin(domain: string, username: string) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_';
  // 22 random characters, regenerated until it has the character classes most sites require.
  let password = '';
  while (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    password = [...crypto.randomBytes(22)].map((b) => charset[b % charset.length]).join('');
  }
  const vid = addItem({ kind: 'login', label: domain, domain, fields: { username, password } });
  const p = vid.slice(0, 8);
  return { id: vid, tokens: { username: `{{vault:${p}.username}}`, password: `{{vault:${p}.password}}` } };
}

export function updateItem(vid: string, input: { label?: string; domain?: string; fields?: Record<string, string> }) {
  const k = requireKey();
  const row = get<VaultRow>('SELECT * FROM vault_items WHERE id = ?', vid);
  if (!row) throw new Error('Not found');
  if (input.fields) {
    const current = JSON.parse(decrypt(row.secret, k)) as Record<string, string>;
    for (const [f, v] of Object.entries(input.fields)) if (v) current[f] = v;
    input = { ...input, fields: current };
  }
  patch(
    'vault_items',
    vid,
    {
      label: input.label,
      domain: input.domain !== undefined ? normalizeDomain(input.domain) : undefined,
      hint: input.fields ? hintFor(row.kind, input.fields) : undefined,
      secret: input.fields ? encrypt(JSON.stringify(input.fields), k) : undefined,
      updated_at: now(),
    },
    ['label', 'domain', 'hint', 'secret', 'updated_at'],
  );
  publish({ type: 'vault.updated' });
}

export function deleteItem(vid: string) {
  run('DELETE FROM vault_items WHERE id = ?', vid);
  publish({ type: 'vault.updated' });
}

/** Check the passphrase without changing lock state (used to re-confirm before revealing). */
export function verifyPassphrase(passphrase: string): boolean {
  const salt = getKV('vault.salt');
  const check = getKV('vault.check');
  if (!salt || !check) return false;
  try {
    return decrypt(check, deriveKey(passphrase, Buffer.from(salt, 'base64'))) === 'errand-vault-ok';
  } catch {
    return false;
  }
}

/** Reveal an item's fields to the user (UI only, never to a model). Requires re-entering the passphrase. */
export function revealItem(vid: string, passphrase: string): Record<string, string> {
  if (!verifyPassphrase(passphrase)) throw new Error('Wrong passphrase');
  const k = requireKey();
  const row = get<VaultRow>('SELECT * FROM vault_items WHERE id = ?', vid);
  if (!row) throw new Error('Not found');
  return JSON.parse(decrypt(row.secret, k));
}

function normalizeDomain(d: string) {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

/** Find an API key by service label; returns the key and where it may be used. Never shown to models. */
export function apiKeyFor(service: string): { label: string; key: string; baseUrl: string; header: string } | null {
  const k = requireKey();
  const row = all<VaultRow>("SELECT * FROM vault_items WHERE kind = 'api_key'").find(
    (r) => r.label.toLowerCase() === service.toLowerCase() || r.domain === service.toLowerCase(),
  );
  if (!row) return null;
  const f = JSON.parse(decrypt(row.secret, k)) as Record<string, string>;
  return { label: row.label, key: f.key, baseUrl: f.base_url ?? '', header: f.header || 'Authorization' };
}

const TOKEN_RE = /\{\{vault:([a-f0-9]{8})\.([a-z0-9_]+)\}\}/g;

/** What a model is told about the vault: labels and the tokens it may use. */
export function tokenCatalog(): string {
  const items = listItems();
  if (!items.length) return 'The vault is empty.';
  const lines = items.map(
    (i) =>
      `- ${i.label} (${i.kind}${i.domain ? `, ${i.domain}` : ''}${i.hint ? `, ${i.hint}` : ''}): ${i.fields.map((f) => `{{vault:${i.id.slice(0, 8)}.${f}}}`).join(' ')}`,
  );
  return `${isUnlocked() ? 'Vault is unlocked.' : 'Vault is LOCKED. Ask the user to unlock it before using tokens.'}\n${lines.join('\n')}`;
}

export interface VaultItemInfo {
  id: string;
  kind: VaultKind;
  label: string;
  domain: string;
  hint: string;
}

/**
 * Replace vault tokens with real values. `guard` runs once per referenced item before anything is
 * filled, so callers can refuse (wrong website) or ask the user. Returns the secrets used, for redaction.
 */
export async function fillTokens(text: string, guard?: (item: VaultItemInfo) => Promise<void>): Promise<{ text: string; secrets: string[] }> {
  const matches = [...text.matchAll(TOKEN_RE)];
  if (!matches.length) return { text, secrets: [] };
  const k = requireKey();
  const rows = all<VaultRow>('SELECT * FROM vault_items');
  const used = new Map<string, VaultRow>();
  for (const m of matches) {
    const row = rows.find((r) => r.id.startsWith(m[1]));
    if (!row) throw new Error(`Unknown vault item ${m[1]}`);
    used.set(row.id, row);
  }
  for (const row of used.values()) await guard?.({ id: row.id, kind: row.kind, label: row.label, domain: row.domain, hint: row.hint });
  const secrets: string[] = [];
  const filled = text.replace(TOKEN_RE, (_m, prefix: string, field: string) => {
    const row = rows.find((r) => r.id.startsWith(prefix))!;
    const value = (JSON.parse(decrypt(row.secret, k)) as Record<string, string>)[field];
    if (value === undefined) throw new Error(`Vault item "${row.label}" has no field "${field}"`);
    if (value.length >= 3) secrets.push(value);
    return value;
  });
  return { text: filled, secrets };
}

export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
  return out;
}
