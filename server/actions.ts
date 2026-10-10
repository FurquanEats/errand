import { z } from 'zod';
import { all, get, id, insert, now, run } from './db.ts';
import { publish } from './bus.ts';
import { generateJSON, hasModel } from './llm.ts';
import { memoryContext } from './memory.ts';
import { getSettings } from './settings.ts';
import { getWeather, weatherLine } from './weather.ts';
import { calendarEnabled, listEvents } from './connectors/calendar.ts';
import { emailEnabled, searchEmail } from './connectors/email.ts';

/**
 * Action Buttons: the proactive feed on the home screen. Errand looks at your calendar, inbox,
 * projects and memory, and suggests one-tap actions ("Check in for tomorrow's flight").
 */

export interface ActionRow {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: string;
  priority: number;
  status: 'open' | 'done' | 'dismissed';
  source: string;
  created_at: number;
}

export const listActions = () => all<ActionRow>("SELECT * FROM actions WHERE status = 'open' ORDER BY priority, created_at DESC LIMIT 30");

export function createAction(input: { title: string; description?: string; prompt: string; icon?: string; priority?: number; source?: string }) {
  const aid = id();
  insert('actions', {
    id: aid,
    title: input.title,
    description: input.description ?? '',
    prompt: input.prompt,
    icon: input.icon ?? '✨',
    priority: input.priority ?? 2,
    status: 'open',
    source: input.source ?? 'proactive',
    created_at: now(),
  });
  publish({ type: 'actions.updated' });
  return aid;
}

/**
 * One button per thing noticed ("ci:acme/shop"): refresh it while it's open, and don't bring it
 * back once done or dismissed unless something new happened after that (`since`).
 */
export function upsertAction(key: string, input: { title: string; description?: string; prompt: string; icon?: string; priority?: number }, since = 0) {
  const last = get<ActionRow & { key: string }>('SELECT * FROM actions WHERE key = ? ORDER BY created_at DESC LIMIT 1', key);
  if (last?.status === 'open') {
    run('UPDATE actions SET title = ?, description = ?, prompt = ? WHERE id = ?', input.title, input.description ?? '', input.prompt, last.id);
    publish({ type: 'actions.updated' });
    return last.id;
  }
  if (last && last.created_at >= since) return null;
  const aid = createAction({ ...input, source: 'noticed' });
  run('UPDATE actions SET key = ? WHERE id = ?', key, aid);
  return aid;
}

export function closeAction(key: string) {
  if (run("UPDATE actions SET status = 'done' WHERE key = ? AND status = 'open'", key).changes) publish({ type: 'actions.updated' });
}

export function setActionStatus(aid: string, status: 'open' | 'done' | 'dismissed') {
  run('UPDATE actions SET status = ? WHERE id = ?', status, aid);
  publish({ type: 'actions.updated' });
}

const suggestions = z.object({
  actions: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().default(''),
        prompt: z.string(),
        icon: z.string().default('✨'),
        priority: z.number().int().min(1).max(3).default(2),
      }),
    )
    .max(8),
});

let generating = false;

export async function generateActions() {
  if (generating || !hasModel()) return;
  generating = true;
  publish({ type: 'actions.generating', value: true });
  try {
    const s = getSettings();
    const parts: string[] = [];
    parts.push(`Now: ${new Date().toLocaleString('en-US', { timeZone: s.timezone, dateStyle: 'full', timeStyle: 'short' })}`);
    const w = await getWeather();
    if (w) parts.push(`Weather: ${weatherLine(w)}`);
    if (calendarEnabled()) {
      const events = await listEvents(undefined, new Date(Date.now() + 3 * 86400_000).toISOString()).catch(() => []);
      parts.push(
        `Calendar (next 3 days):\n${events.map((e) => `- ${e.start}${e.allDay ? ' (all day)' : ''}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(nothing)'}`,
      );
    }
    if (emailEnabled()) {
      const mail = await searchEmail({ unreadOnly: true, sinceDays: 3, limit: 25 }).catch(() => []);
      parts.push(`Unread email (last 3 days):\n${mail.map((m) => `- [${m.id}] (${m.account}) ${m.from}: ${m.subject}`).join('\n') || '(none)'}`);
    }
    const tasks = all<{ title: string; due: string | null; project: string }>(
      'SELECT t.title, t.due, p.name AS project FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.done = 0 AND p.archived = 0 ORDER BY t.due IS NULL, t.due LIMIT 30',
    );
    if (tasks.length) parts.push(`Open project tasks:\n${tasks.map((t) => `- ${t.project}: ${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('\n')}`);
    const existing = listActions();
    if (existing.length) parts.push(`Already showing (do not duplicate):\n${existing.map((a) => `- ${a.title}`).join('\n')}`);
    const recentlyDismissed = all<{ title: string }>("SELECT title FROM actions WHERE status = 'dismissed' ORDER BY created_at DESC LIMIT 15");
    if (recentlyDismissed.length) parts.push(`User dismissed these recently (avoid similar):\n${recentlyDismissed.map((a) => `- ${a.title}`).join('\n')}`);

    const result = await generateJSON({
      role: 'utility',
      system:
        `You are the proactive brain of Errand, a personal assistant for ${s.userName || 'the user'}. ` +
        'Suggest up to 6 concrete, timely actions the assistant could take right now, prioritised by urgency (1 = urgent). ' +
        'Start every title with a verb, Hark-style: "Reply to Sam about Friday dinner", "Find a birthday gift for Dad, Nov 12", "Check in for UA 512", "File Wheelness alerts under a label". ' +
        'Each prompt is what the assistant will execute when tapped, written as an instruction with all needed specifics (email ids, names, dates). ' +
        'Only suggest things grounded in the context below. Fewer, better suggestions beat filler. Use a single emoji icon.',
      prompt: `${parts.join('\n\n')}\n\nWhat the assistant knows about the user:\n${memoryContext('', 60)}`,
      schema: suggestions,
      example:
        '{"actions":[{"title":"Reply to Sam about dinner","description":"Sam asked if Friday 7pm works","prompt":"Read email uid 4512 from Sam and draft a reply confirming Friday 7pm","icon":"✉️","priority":1}]}',
    });
    // Replace stale proactive suggestions, keep ones pinned from chat.
    run("UPDATE actions SET status = 'dismissed' WHERE status = 'open' AND source = 'proactive' AND created_at < ?", now() - 60_000);
    for (const a of result.actions) createAction({ ...a, source: 'proactive' });
  } catch (err) {
    console.warn('[actions]', (err as Error).message);
  } finally {
    generating = false;
    publish({ type: 'actions.generating', value: false });
    publish({ type: 'actions.updated' });
  }
}
