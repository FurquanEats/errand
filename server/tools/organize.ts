import { tool } from 'ai';
import { z } from 'zod';
import { all } from '../db.ts';
import { addTask, createProject, findProject, listProjects, updateProject, updateTask } from '../projects.ts';
import { createAction, listActions, setActionStatus } from '../actions.ts';
import { createPanel, deletePanel, editPanel, listPanels, refreshPanel, updatePanel } from '../panels.ts';
import { createRoutine, deleteRoutine, describeSchedule, listRoutines, updateRoutine } from '../routines.ts';
import { scanMail, spending, statusNames, summary, TRACKERS, updateTracked } from '../trackers.ts';
import { listAccounts } from '../connectors/email.ts';
import type { ToolContext } from './index.ts';

/** Projects, home-screen action buttons, panels and routines. */
export const organizeTools = (_ctx: ToolContext) => ({
  project_list: tool({
    description: 'List the user’s projects.',
    inputSchema: z.object({}),
    execute: async () => listProjects().map((p) => ({ id: p.id, name: p.name, description: p.description, open_tasks: p.open_tasks })),
  }),
  project_create: tool({
    description: 'Create a project for a larger goal (job search, trip, move, renovation), optionally with tasks.',
    inputSchema: z.object({ name: z.string(), description: z.string().optional(), emoji: z.string().optional(), tasks: z.array(z.string()).optional() }),
    execute: async ({ name, description, emoji, tasks }) => {
      const pid = createProject({ name, description, emoji });
      for (const task of tasks ?? []) addTask(pid, task);
      return { id: pid };
    },
  }),
  project_add_task: tool({
    description: 'Add a task to a project.',
    inputSchema: z.object({ project: z.string().describe('project name or id'), title: z.string(), due: z.string().optional() }),
    execute: async ({ project, title, due }) => {
      const p = findProject(project);
      return p ? { id: addTask(p.id, title, due) } : { error: 'project not found' };
    },
  }),
  project_complete_task: tool({
    description: 'Mark a project task done (or not done).',
    inputSchema: z.object({ task_id: z.string(), done: z.boolean().default(true) }),
    execute: async ({ task_id, done }) => {
      const task = all<{ id: string }>('SELECT id FROM project_tasks').find((x) => x.id.startsWith(task_id));
      if (!task) return { error: 'task not found' };
      updateTask(task.id, { done });
      return { ok: true };
    },
  }),
  project_update_notes: tool({
    description: 'Replace a project’s notes document (markdown). Keep findings, options, decisions and links here.',
    inputSchema: z.object({ project: z.string(), notes: z.string() }),
    execute: async ({ project, notes }) => {
      const p = findProject(project);
      if (!p) return { error: 'project not found' };
      updateProject(p.id, { notes });
      return { ok: true };
    },
  }),
  action_button_create: tool({
    description: 'Pin a one-tap action button to the home screen for something to do or approve later. Start the title with a verb ("Book…", "Reply…").',
    inputSchema: z.object({
      title: z.string().max(70),
      description: z.string().optional(),
      prompt: z.string().describe('what to run when tapped'),
      icon: z.string().optional(),
    }),
    execute: async (input) => ({ id: createAction({ ...input, source: 'chat' }) }),
  }),
  action_button_update: tool({
    description: 'List the home-screen action buttons (omit id), or mark one done or dismiss it ("I already paid that bill", "remove the gift card").',
    inputSchema: z.object({ id: z.string().optional(), status: z.enum(['done', 'dismissed']).optional() }),
    execute: async ({ id, status }) => {
      const open = listActions();
      if (!id) return open.map((a) => ({ id: a.id.slice(0, 8), title: a.title }));
      const a = open.find((x) => x.id.startsWith(id));
      if (!a) return { error: 'not found' };
      setActionStatus(a.id, status ?? 'dismissed');
      return { [status ?? 'dismissed']: a.title };
    },
  }),
  panel_create: tool({
    description:
      'Build a live home-screen panel (mini app) from a description, e.g. "my week of calendar events", "BTC price", "Strava weekly miles". ' +
      'Job applications, orders and deliveries, bills and renewals, and trips are already tracked on Home from email: use tracker_list for those instead of building a panel.',
    inputSchema: z.object({ description: z.string() }),
    execute: async ({ description }) => {
      const p = await createPanel(description);
      return { id: p.id, title: p.title };
    },
  }),
  routine_create: tool({
    description:
      'Schedule a task Errand runs on its own: once at a date/time ("next Friday 9am, buy the gift card"), or recurring (morning briefing, inbox sweep every 3 hours, weekly groceries). ' +
      'Times are in the user’s time zone. days: 0=Sun..6=Sat.',
    inputSchema: z.object({
      title: z.string(),
      prompt: z.string().describe('the full instruction to run each time'),
      kind: z.enum(['once', 'daily', 'weekly', 'interval']),
      at: z.string().optional().describe('ISO date-time with offset, for once'),
      time: z.string().optional().describe('HH:MM for daily/weekly'),
      days: z.array(z.number().int().min(0).max(6)).optional(),
      hours: z.number().optional().describe('for interval'),
    }),
    execute: async ({ title, prompt, kind, at, time, days, hours }) => {
      const schedule = { kind, at, time, days, hours };
      return { id: createRoutine({ title, prompt, schedule }), schedule: describeSchedule(schedule) };
    },
  }),
  routine_list: tool({
    description: 'List scheduled routines.',
    inputSchema: z.object({}),
    execute: async () =>
      listRoutines().map((r) => ({ id: r.id.slice(0, 8), title: r.title, schedule: describeSchedule(r.schedule), enabled: r.enabled, prompt: r.prompt })),
  }),
  routine_update: tool({
    description: 'Pause, resume, reschedule, reword or delete a routine (id from routine_list).',
    inputSchema: z.object({
      id: z.string(),
      enabled: z.boolean().optional(),
      remove: z.boolean().optional(),
      title: z.string().optional(),
      prompt: z.string().optional(),
      kind: z.enum(['once', 'daily', 'weekly', 'interval']).optional().describe('new schedule; give the matching fields below'),
      at: z.string().optional(),
      time: z.string().optional(),
      days: z.array(z.number().int().min(0).max(6)).optional(),
      hours: z.number().optional(),
    }),
    execute: async ({ id, enabled, remove, title, prompt, kind, at, time, days, hours }) => {
      const r = listRoutines().find((x) => x.id.startsWith(id));
      if (!r) return { error: 'not found' };
      if (remove) return (deleteRoutine(r.id), { removed: r.title });
      updateRoutine(r.id, { enabled, title, prompt, schedule: kind ? { kind, at, time, days, hours } : undefined });
      return { updated: r.title };
    },
  }),
  tracker_list: tool({
    description:
      'What Errand tracks on its own from email: job applications, orders and deliveries, bills and renewals, trips and bookings, with each item’s status and latest news. ' +
      'Use it for "how are my applications going?", "where is my parcel?", "what bills are due?". Set check_now to read new mail first.',
    inputSchema: z.object({ tracker: z.enum(Object.keys(TRACKERS) as [string, ...string[]]).optional(), check_now: z.boolean().optional() }),
    execute: async ({ tracker, check_now }) => {
      if (check_now) await scanMail();
      const accounts = listAccounts().map((a) => a.address);
      const trackers = summary()
        .filter((t) => !tracker || t.id === tracker)
        .map((t) => ({ ...t, items: t.items.map((i) => ({ ...i, id: i.id.slice(0, 8), at: new Date(i.at).toISOString() })) }));
      if (trackers.some((t) => t.total)) return { trackers, searched: accounts };
      return {
        trackers,
        searched: accounts,
        note: accounts.length
          ? `Nothing found yet in ${accounts.join(', ')} (the last 60 days, checked every 15 minutes). Say so plainly, ask whether these emails go to another address, and offer connect_account to add it in one tap.`
          : 'No email account is connected, so there is nothing to track yet. Offer connect_account (google for Gmail, microsoft for Outlook, email for others).',
      };
    },
  }),
  tracker_update: tool({
    description: `Correct or remove a tracked item (id from tracker_list): set its status, or hide it ("I withdrew from Acme", "stop tracking that order"). Statuses: ${Object.keys(statusNames).join(', ')}.`,
    inputSchema: z.object({ id: z.string(), status: z.string().optional(), hide: z.boolean().optional() }),
    execute: async ({ id, status, hide }) => ({ updated: updateTracked(id, { status, hidden: hide }).title }),
  }),
  spending: tool({
    description: 'Spending by merchant over the last N days, read from card, UPI and receipt emails ("how much did I spend on Zomato this month?").',
    inputSchema: z.object({ days: z.number().int().min(1).max(365).default(30), merchant: z.string().optional() }),
    execute: async ({ days, merchant }) => spending(days, merchant),
  }),
  panel_list: tool({
    description: 'List the home-screen panels with their latest data, to answer questions about them.',
    inputSchema: z.object({}),
    execute: async () =>
      listPanels().map((p) => ({ id: p.id.slice(0, 8), title: p.title, size: p.size, data: p.data?.slice(0, 2000) ?? null, error: p.error })),
  }),
  panel_update: tool({
    description: 'Change a panel (redesign it or what it shows), resize it, refresh its data now, or remove it. id from panel_list.',
    inputSchema: z.object({
      id: z.string(),
      change: z.string().optional().describe('what to change, in plain words'),
      size: z.enum(['sm', 'md', 'lg']).optional(),
      refresh: z.boolean().optional(),
      remove: z.boolean().optional(),
    }),
    execute: async ({ id, change, size, refresh, remove }) => {
      const p = listPanels().find((x) => x.id.startsWith(id));
      if (!p) return { error: 'not found' };
      if (remove) return (deletePanel(p.id), { removed: p.title });
      if (size) updatePanel(p.id, { size });
      if (change) await editPanel(p.id, change);
      else if (refresh) await refreshPanel(p.id);
      return { updated: p.title };
    },
  }),
});
