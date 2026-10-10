import { all } from './db.ts';

/** Search conversations by title and message text, returning a short snippet around the match. */
export function searchConversations(query: string) {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const rows = all<{ id: string; title: string; updated_at: number; content: string | null }>(
    `SELECT c.id, c.title, c.updated_at,
       (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 1) AS content
     FROM conversations c
     WHERE c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\')
     ORDER BY c.updated_at DESC LIMIT 30`,
    like,
    like,
    like,
  );
  return rows.map((r) => ({ id: r.id, title: r.title, updated_at: r.updated_at, snippet: snippet(r.content, q) }));
}

function snippet(content: string | null, q: string) {
  if (!content) return '';
  let text = '';
  try {
    const parts = JSON.parse(content);
    text = Array.isArray(parts) ? parts.map((p: any) => p.text ?? '').join(' ') : String(parts);
  } catch {
    text = content;
  }
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 120);
  return (i > 40 ? '…' : '') + text.slice(Math.max(0, i - 40), i + q.length + 80).replace(/\s+/g, ' ') + '…';
}
