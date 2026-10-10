import { all, get, id, insert, now, parseJSON, patch, run } from './db.ts';
import { publish } from './bus.ts';
import { getSettings } from './settings.ts';
import { activeRunFor, mainConversationId, sendMessage } from './chat.ts';
import { notify } from './notify.ts';

/**
 * Routines: things Errand does on a schedule without being asked.
 * "Every weekday at 8:00 brief me on my day", "Every Sunday check my kid's lunch card balance
 * and top it up if it's under $10", "Every 6 hours look for price drops on that flight".
 */

export interface Schedule {
  kind: 'daily' | 'weekly' | 'interval' | 'once';
  at?: string; // ISO date-time, for one-time tasks
  time?: string; // "HH:MM" in the user's time zone
  days?: number[]; // 0 = Sunday … 6 = Saturday (weekly)
  hours?: number; // interval
}

export interface Routine {
  id: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  last_run: number | null;
  last_conversation: string | null;
  created_at: number;
}

const toRoutine = (r: any): Routine => ({ ...r, schedule: parseJSON(r.schedule, { kind: 'daily', time: '08:00' }), enabled: !!r.enabled });

export const listRoutines = () => all('SELECT * FROM routines ORDER BY created_at').map(toRoutine);

export function createRoutine(input: { title: string; prompt: string; schedule: Schedule }) {
  validate(input.schedule);
  const rid = id();
  insert('routines', {
    id: rid,
    title: input.title,
    prompt: input.prompt,
    schedule: JSON.stringify(input.schedule),
    enabled: 1,
    last_run: input.schedule.kind === 'interval' ? now() : null,
    last_conversation: null,
    created_at: now(),
  });
  publish({ type: 'routines.updated' });
  return rid;
}

export function updateRoutine(rid: string, input: Partial<{ title: string; prompt: string; schedule: Schedule; enabled: boolean }>) {
  if (input.schedule) validate(input.schedule);
  patch(
    'routines',
    rid,
    {
      title: input.title,
      prompt: input.prompt,
      schedule: input.schedule && JSON.stringify(input.schedule),
      enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
    },
    ['title', 'prompt', 'schedule', 'enabled'],
  );
  publish({ type: 'routines.updated' });
}

export function deleteRoutine(rid: string) {
  run('DELETE FROM routines WHERE id = ?', rid);
  publish({ type: 'routines.updated' });
}

function validate(s: Schedule) {
  if (s.kind === 'once') {
    if (!s.at || Number.isNaN(Date.parse(s.at))) throw new Error('A one-time task needs a valid date and time');
    return;
  }
  if (s.kind === 'interval') {
    if (!s.hours || s.hours < 0.25) throw new Error('Interval must be at least 15 minutes');
  } else if (!/^\d{2}:\d{2}$/.test(s.time ?? '')) throw new Error('Time must be HH:MM');
  if (s.kind === 'weekly' && !s.days?.length) throw new Error('Pick at least one day');
}

export function describeSchedule(s: Schedule) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (s.kind === 'once')
    return `Once, ${new Date(s.at!).toLocaleString('en-US', { timeZone: getSettings().timezone, dateStyle: 'medium', timeStyle: 'short' })}`;
  if (s.kind === 'interval') return `Every ${s.hours} hour${s.hours === 1 ? '' : 's'}`;
  if (s.kind === 'weekly') return `${s.days!.map((d) => DAYS[d]).join(', ')} at ${s.time}`;
  return `Every day at ${s.time}`;
}

/** Wall-clock parts in the user's time zone. */
function zoned(ts: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(ts)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    hm: `${hour}:${parts.minute}`,
    minuteKey: `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`,
  };
}

export function isDue(r: Routine, ts: number, tz: string) {
  const s = r.schedule;
  if (s.kind === 'once') return !r.last_run && ts >= Date.parse(s.at!);
  if (s.kind === 'interval') return !r.last_run || ts - r.last_run >= s.hours! * 3600_000;
  const z = zoned(ts, tz);
  if (z.hm !== s.time) return false;
  if (s.kind === 'weekly' && !s.days!.includes(z.day)) return false;
  return !r.last_run || zoned(r.last_run, tz).minuteKey !== z.minuteKey;
}

export async function runRoutine(rid: string) {
  const r = get('SELECT * FROM routines WHERE id = ?', rid);
  if (!r) throw new Error('Routine not found');
  const routine = toRoutine(r);
  const cid = mainConversationId();
  for (let i = 0; i < 300 && activeRunFor(cid); i++) await new Promise((r) => setTimeout(r, 1000));
  patch('routines', rid, { last_run: now(), last_conversation: cid }, ['last_run', 'last_conversation']);
  publish({ type: 'routines.updated' });
  await sendMessage(cid, `[Scheduled routine “${routine.title}”]\n${routine.prompt}`, [], 'routine');
  void notify({ title: `Routine started: ${routine.title}`, url: `/#/c/${cid}` });
  return cid;
}

/** Called every minute by the scheduler. */
export async function runDueRoutines() {
  const tz = getSettings().timezone;
  const ts = now();
  for (const r of listRoutines()) {
    if (r.enabled && isDue(r, ts, tz)) await runRoutine(r.id).catch((e) => console.warn('[routine]', r.title, e.message));
  }
}
