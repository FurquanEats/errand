import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutine, describeSchedule, isDue, type Routine } from '../server/routines.ts';
import { extractJSON } from '../server/llm.ts';

const routine = (schedule: Routine['schedule'], last_run: number | null = null): Routine => ({
  id: 'r',
  title: 't',
  prompt: 'p',
  schedule,
  enabled: true,
  last_run,
  last_conversation: null,
  created_at: 0,
});

test('daily routines fire once at their minute, in the user time zone', () => {
  const at = Date.parse('2026-10-07T08:00:30+05:30');
  const r = routine({ kind: 'daily', time: '08:00' });
  assert.equal(isDue(r, at, 'Asia/Kolkata'), true);
  assert.equal(isDue(routine({ kind: 'daily', time: '08:00' }, at), at + 10_000, 'Asia/Kolkata'), false);
  assert.equal(isDue(r, at, 'America/New_York'), false);
});

test('weekly routines respect their days', () => {
  const wednesday = Date.parse('2026-10-07T09:00:00Z');
  assert.equal(isDue(routine({ kind: 'weekly', time: '09:00', days: [3] }), wednesday, 'UTC'), true);
  assert.equal(isDue(routine({ kind: 'weekly', time: '09:00', days: [1, 5] }), wednesday, 'UTC'), false);
});

test('interval and one-time schedules', () => {
  const now = Date.now();
  assert.equal(isDue(routine({ kind: 'interval', hours: 3 }, now - 2 * 3600_000), now, 'UTC'), false);
  assert.equal(isDue(routine({ kind: 'interval', hours: 3 }, now - 3 * 3600_000), now, 'UTC'), true);
  assert.equal(isDue(routine({ kind: 'once', at: new Date(now - 1000).toISOString() }), now, 'UTC'), true);
  assert.equal(isDue(routine({ kind: 'once', at: new Date(now - 1000).toISOString() }, now - 500), now, 'UTC'), false);
  assert.equal(isDue(routine({ kind: 'once', at: new Date(now + 60_000).toISOString() }), now, 'UTC'), false);
});

test('invalid schedules are rejected with a clear message', () => {
  assert.throws(() => createRoutine({ title: 'x', prompt: 'y', schedule: { kind: 'daily', time: '8am' } }), /HH:MM/);
  assert.throws(() => createRoutine({ title: 'x', prompt: 'y', schedule: { kind: 'weekly', time: '08:00', days: [] } }), /day/);
  assert.throws(() => createRoutine({ title: 'x', prompt: 'y', schedule: { kind: 'once', at: 'soon' } }), /date/);
  assert.equal(describeSchedule({ kind: 'weekly', time: '09:00', days: [1, 5] }), 'Mon, Fri at 09:00');
});

test('JSON is extracted from chatty model output', () => {
  assert.deepEqual(extractJSON('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Here you go: [1,2,3] hope that helps'), [1, 2, 3]);
  assert.throws(() => extractJSON('no json here'));
});

test('a blank or unknown time zone is never saved', async () => {
  const { getSettings, saveSettings } = await import('../server/settings.ts');
  saveSettings({ timezone: 'Asia/Kolkata' });
  saveSettings({ timezone: '' });
  saveSettings({ timezone: 'Mars/Olympus' });
  assert.equal(getSettings().timezone, 'Asia/Kolkata');
});
