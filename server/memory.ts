import { z } from 'zod';
import { all, id, insert, now, patch, run } from './db.ts';
import { generateJSON } from './llm.ts';
import { publish } from './bus.ts';

export interface Memory {
  id: string;
  content: string;
  category: string;
  source: string;
  created_at: number;
  updated_at: number;
}

// 'specialty' holds workflows the user taught Errand (how to do a multi-step task their way).
export const CATEGORIES = ['profile', 'preferences', 'people', 'places', 'work', 'health', 'finance', 'routine', 'specialty', 'general'];

export const listMemories = () => all<Memory>('SELECT * FROM memories ORDER BY updated_at DESC');

export function addMemory(content: string, category = 'general', source = 'chat') {
  const mid = id();
  insert('memories', { id: mid, content: content.trim(), category, source, created_at: now(), updated_at: now() });
  publish({ type: 'memories.updated' });
  return mid;
}

export function updateMemory(mid: string, changes: { content?: string; category?: string }) {
  patch('memories', mid, { ...changes, updated_at: now() }, ['content', 'category', 'updated_at']);
  publish({ type: 'memories.updated' });
}

export function deleteMemory(mid: string) {
  run('DELETE FROM memories WHERE id = ?', mid);
  publish({ type: 'memories.updated' });
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

export function searchMemories(query: string, limit = 20): Memory[] {
  const q = words(query);
  return listMemories()
    .map((m) => {
      const w = words(m.content + ' ' + m.category);
      let score = 0;
      for (const t of q) if (w.has(t)) score++;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** Memory block for system prompts. Everything fits for typical use; otherwise profile + relevant. */
export function memoryContext(query = '', max = 120): string {
  const mems = listMemories();
  if (!mems.length) return 'Nothing remembered yet.';
  let chosen = mems;
  if (mems.length > max) {
    const core = mems.filter((m) => ['profile', 'preferences', 'specialty'].includes(m.category)).slice(0, max / 2);
    const relevant = searchMemories(query, max / 2);
    const seen = new Set<string>();
    chosen = [...core, ...relevant].filter((m) => !seen.has(m.id) && seen.add(m.id));
  }
  return chosen.map((m) => `- [${m.category}] ${m.content} (id:${m.id.slice(0, 8)})`).join('\n');
}

const extraction = z.object({
  add: z.array(z.object({ content: z.string(), category: z.string() })).default([]),
  update: z.array(z.object({ id: z.string(), content: z.string() })).default([]),
  remove: z.array(z.string()).default([]),
});

/**
 * After each exchange, a cheap model decides whether anything durable was learned about the user.
 * This is what makes the assistant feel like it knows you.
 */
export async function extractMemories(userText: string, assistantText: string) {
  if (userText.trim().length < 8) return;
  const existing = listMemories().slice(0, 150);
  const result = await generateJSON({
    role: 'utility',
    system:
      'You maintain the long-term memory of a personal assistant. Save only durable, useful facts about the user ' +
      '(identity, family, preferences, dietary needs, addresses, routines, goals, accounts they use, important dates). ' +
      'Never store passwords, card numbers, or one-off requests. Prefer updating an existing memory over duplicating it. ' +
      'If the user spelled out how they want a repeatable multi-step task done, save it once as a "specialty": "<name> (when <situation>): 1) … 2) …". ' +
      `Categories: ${CATEGORIES.join(', ')}. Return empty arrays when nothing new was learned (that is the usual case).`,
    prompt: `Existing memories:\n${existing.map((m) => `${m.id.slice(0, 8)} [${m.category}] ${m.content}`).join('\n') || '(none)'}\n\nLatest exchange:\nUSER: ${userText.slice(0, 4000)}\nASSISTANT: ${assistantText.slice(0, 2000)}`,
    schema: extraction,
    example: '{"add":[{"content":"Is vegetarian","category":"preferences"}],"update":[{"id":"1a2b3c4d","content":"Lives in Austin, TX"}],"remove":[]}',
  });
  const byPrefix = (p: string) => existing.find((m) => m.id.startsWith(p));
  for (const a of result.add) if (a.content.trim()) addMemory(a.content, CATEGORIES.includes(a.category) ? a.category : 'general', 'auto');
  for (const u of result.update) {
    const m = byPrefix(u.id);
    if (m) updateMemory(m.id, { content: u.content });
  }
  for (const r of result.remove) {
    const m = byPrefix(r);
    if (m) deleteMemory(m.id);
  }
}
