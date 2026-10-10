import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { getSettings } from '../settings.ts';

/** File access, limited to folders you list in Settings → Connections → Files. */

export const filesEnabled = () => getSettings().files.roots.length > 0;

function resolveSafe(p: string): string {
  const roots = getSettings().files.roots.map((r) => path.resolve(r));
  if (!roots.length) throw new Error('No folders are shared. Add one in Settings → Connections → Files.');
  const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(roots[0], p);
  // Compare real paths (following symlinks) of the target, or of its nearest existing parent.
  const real = (x: string): string => {
    try {
      return realpathSync(x);
    } catch {
      const parent = path.dirname(x);
      return parent === x ? x : path.join(real(parent), path.basename(x));
    }
  };
  const realTarget = real(target);
  const ok = roots.map(real).some((r) => realTarget === r || realTarget.startsWith(r + path.sep));
  if (!ok) throw new Error(`Access denied: ${target} is outside the shared folders (${roots.join(', ')})`);
  return realTarget;
}

export async function listDir(p = '') {
  if (!p) return { roots: getSettings().files.roots };
  const dir = resolveSafe(p);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return {
    path: dir,
    entries: await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        const full = path.join(dir, e.name);
        const st = await fs.stat(full).catch(() => null);
        return { name: e.name, dir: e.isDirectory(), size: st?.size ?? 0, modified: st?.mtime.toISOString() ?? '' };
      }),
    ),
  };
}

export async function readFile(p: string, maxChars = 30000) {
  const file = resolveSafe(p);
  const st = await fs.stat(file);
  if (st.size > 20 * 1024 * 1024) throw new Error('File too large to read');
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) return { path: file, binary: true, size: st.size };
  const text = buf.toString('utf8');
  return { path: file, size: st.size, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
}

export async function writeFile(p: string, content: string) {
  const file = resolveSafe(p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return { path: file, bytes: Buffer.byteLength(content) };
}

export async function searchFiles(query: string, limit = 50) {
  const q = query.toLowerCase();
  const hits: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 6 || hits.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q)) hits.push(full);
      if (e.isDirectory()) await walk(full, depth + 1);
    }
  }
  for (const r of getSettings().files.roots) await walk(path.resolve(r), 0);
  return hits;
}
