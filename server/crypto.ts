import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

// A per-install key that protects API keys and connector passwords at rest, so a copied
// database alone does not leak them. The vault uses a separate key derived from your passphrase.
const LOCAL_KEY_FILE = path.join(DATA_DIR, 'local.key');
let localKey: Buffer;
if (fs.existsSync(LOCAL_KEY_FILE)) {
  localKey = Buffer.from(fs.readFileSync(LOCAL_KEY_FILE, 'utf8').trim(), 'base64');
} else {
  localKey = crypto.randomBytes(32);
  fs.writeFileSync(LOCAL_KEY_FILE, localKey.toString('base64'), { mode: 0o600 });
}

export const seal = (plain: string) => (plain ? encrypt(plain, localKey) : '');
export function unseal(payload: string | null | undefined): string {
  if (!payload) return '';
  try {
    return decrypt(payload, localKey);
  } catch {
    return '';
  }
}
