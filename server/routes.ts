import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { generateText, experimental_transcribe as transcribe } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { publish, subscribe } from './bus.ts';
import { PASSWORD, PORT } from './config.ts';
import { loginAllowed, loginFailed, loginSucceeded, requestGuard } from './security.ts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { all } from './db.ts';
import { searchConversations } from './search.ts';
import { seal, unseal } from './crypto.ts';
import { getKV, getSettings, saveSettings, setKV, type Settings } from './settings.ts';
import * as llm from './llm.ts';
import * as chat from './chat.ts';
import * as mem from './memory.ts';
import * as projects from './projects.ts';
import * as vault from './vault.ts';
import * as handoff from './handoff/agent.ts';
import * as live from './handoff/live.ts';
import { z } from 'zod';
import * as approvals from './approvals.ts';
import * as actions from './actions.ts';
import * as panels from './panels.ts';
import * as mcp from './connectors/mcp.ts';
import * as email from './connectors/email.ts';
import * as google from './connectors/google.ts';
import * as chatgpt from './connectors/chatgpt.ts';
import * as openrouter from './connectors/openrouter.ts';
import { listEvents } from './connectors/calendar.ts';
import { versionInfo } from './updates.ts';
import * as microsoft from './connectors/microsoft.ts';
import { phoneCode, phoneStatus, setPhone } from './phone.ts';
import { geocode, getWeather } from './weather.ts';
import * as routines from './routines.ts';
import { runBrief } from './brief.ts';
import { scanMail, summary as trackerSummary, updateTracked } from './trackers.ts';
import { readStoredFile } from './documents.ts';
import { exportAllData, deleteAllData } from './data.ts';
import { canStartAtLogin, isQuitting, quitSoon, setStartsAtLogin, startUpdate, startsAtLogin } from './lifecycle.ts';
import { openApp } from './open.ts';
import fs from 'node:fs';
import { notify } from './notify.ts';

export const api = new Hono();

api.use('*', requestGuard);
api.use('*', bodyLimit({ maxSize: 80 * 1024 * 1024 }));

// ── Passwords ─────────────────────────────────────────────────────────────────
// Requests through the phone listener (see phone.ts) always need the phone code; the local one
// needs ERRAND_PASSWORD only if it's set. Sessions are an HMAC of the secret, so a new code signs out.
const fromPhone = (c: { env: unknown }) => !!(c.env as { phone?: boolean } | undefined)?.phone;
const secretFor = (c: { env: unknown }) => (fromPhone(c) ? phoneCode() || crypto.randomBytes(16).toString('hex') : PASSWORD);
const tokenFor = (secret: string) => crypto.createHmac('sha256', secret).update('errand-session').digest('hex');

api.post('/login', async (c) => {
  const ip = getConnInfo(c).remote.address ?? 'unknown';
  if (!loginAllowed(ip)) return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429);
  const { password } = await c.req.json();
  const secret = secretFor(c);
  // Compare fixed-length digests so timing reveals nothing about the password length.
  const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
  // Phone codes are forgiving about case and stray spaces.
  const given = fromPhone(c)
    ? String(password ?? '')
        .trim()
        .toLowerCase()
    : String(password ?? '');
  if (!secret || crypto.timingSafeEqual(digest(given), digest(secret))) {
    loginSucceeded(ip);
    setCookie(c, 'errand', tokenFor(secret), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      secure: new URL(c.req.url).protocol === 'https:',
    });
    return c.json({ ok: true });
  }
  loginFailed(ip);
  return c.json({ error: 'Wrong password' }, 401);
});

api.use('*', async (c, next) => {
  const secret = secretFor(c);
  if (!secret || c.req.path.endsWith('/login') || getCookie(c, 'errand') === tokenFor(secret)) return next();
  return c.json({ error: 'auth', needsLogin: true, phone: fromPhone(c) }, 401);
});

// The phone reaches Errand over your Wi-Fi. Anything that runs a program, opens a folder, changes
// sign-in apps or takes all your data at once is done on the computer itself.
const COMPUTER_ONLY_SETTINGS = ['files', 'handoff', 'google', 'microsoft'];
api.use('*', async (c, next) => {
  if (!fromPhone(c)) return next();
  const p = c.req.path.replace(/^\/api/, '');
  const write = c.req.method !== 'GET';
  let blocked = p.startsWith('/data/') || (p.startsWith('/mcp') && write);
  if (!blocked && p === '/settings' && c.req.method === 'PUT') {
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => ({}));
    blocked = COMPUTER_ONLY_SETTINGS.some((k) => body && typeof body === 'object' && k in body);
  }
  return blocked ? c.json({ error: 'Do this on your computer: it isn’t available from the phone.' }, 403) : next();
});

// ── Use on your phone (only switchable from this computer) ───────────────────
api.get('/phone', (c) => (fromPhone(c) ? c.json({ error: 'Not available from the phone' }, 403) : c.json(phoneStatus())));
api.post('/phone', async (c) => {
  if (fromPhone(c)) return c.json({ error: 'Not available from the phone' }, 403);
  const { enabled, newCode } = await c.req.json();
  return c.json(await setPhone(!!enabled, !!newCode));
});

api.onError((err, c) => {
  console.error('[api]', c.req.method, c.req.path, err.message);
  return c.json({ error: err.message }, 400);
});

// ── Status & live events ───────────────────────────────────────────────────────
api.get('/version', async (c) => c.json(await versionInfo(c.req.query('check') === '1')));
// Settings → About → Update now: the installer closes Errand, updates it and opens it again.
api.post('/update', (c) => {
  if (fromPhone(c)) return c.json({ error: 'Update from your computer' }, 403);
  return startUpdate() ? c.json({ ok: true }) : c.json({ error: 'This copy of Errand cannot update itself. Run the installer again.' }, 400);
});
// 503 while quitting, so a launcher started right then waits instead of finding a dying Errand.
api.get('/status', (c) =>
  isQuitting()
    ? c.json({ error: 'Errand is shutting down' }, 503)
    : c.json({
        hasModel: llm.hasModel(),
        vault: vault.status(),
        userName: getSettings().userName,
        onboarded: isOnboarded(),
        phone: fromPhone(c), // sign-ins only work on the computer itself
      }),
);
api.post('/onboarding/done', (c) => (setKV('onboarding.done', '1'), c.json({ ok: true })));

// Errand windows open on this computer. The icon by the clock (Errand.exe, ?client=tray) only gets
// notifications, and only while no window is open to show them itself.
let windowsOpen = 0;
api.get('/events', (c) => {
  const tray = c.req.query('client') === 'tray' && !fromPhone(c);
  const isWindow = !tray && !fromPhone(c);
  return streamSSE(c, async (stream) => {
    if (isWindow) windowsOpen++;
    const unsub = subscribe((e) => {
      if (tray && (e.type !== 'notify' || windowsOpen > 0)) return;
      stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {});
    });
    const ping = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}), 25000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsub();
    if (isWindow) windowsOpen--;
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
// Secrets never leave the server: the UI only learns whether one is set.
function publicSettings(s: Settings) {
  return {
    ...s,
    search: { ...s.search, apiKey: '', hasApiKey: !!s.search.apiKey },
    google: { clientId: s.google.clientId, clientSecret: '', hasClientSecret: !!s.google.clientSecret, redirectUri: google.redirectUri() },
    microsoft: { clientId: s.microsoft.clientId, ready: microsoft.microsoftConfigured(), redirectUri: microsoft.microsoftRedirectUri() },
  };
}
api.get('/settings', (c) => c.json(publicSettings(getSettings())));
api.put('/settings', async (c) => {
  const body = (await c.req.json()) as Partial<Settings>;
  if (body.google) {
    body.google = {
      clientId: body.google.clientId ?? '',
      clientSecret: body.google.clientSecret ? seal(body.google.clientSecret) : getSettings().google.clientSecret,
    };
  }
  if (body.microsoft) body.microsoft = { clientId: String(body.microsoft.clientId ?? '').trim() };
  if (body.search) {
    delete (body.search as any).hasApiKey;
    body.search.apiKey = body.search.apiKey ? seal(body.search.apiKey) : getSettings().search.apiKey;
  }
  const saved = saveSettings(body);
  publish({ type: 'settings.updated' });
  return c.json(publicSettings(saved));
});

// ── Providers & models ────────────────────────────────────────────────────────
api.get('/providers', (c) => c.json({ providers: llm.listProviders(), presets: llm.PROVIDER_PRESETS }));
api.post('/providers', async (c) => {
  const body = await c.req.json();
  if (body.auto) {
    // "Pick the best models for me": choose the strongest chat model and a fast one for background jobs.
    const pick = llm.pickBestModels(await llm.fetchModelList({ kind: body.kind, baseUrl: body.baseUrl, apiKey: body.apiKey }));
    if (!pick) return c.json({ error: 'This key returned no models. Turn off automatic choice and type a model id.' }, 400);
    const pid = llm.addProvider({ ...body, models: [...new Set([pick.best, pick.fast])] });
    const s = getSettings();
    saveSettings({ models: { ...s.models, chat: `${pid}:${pick.best}`, handoff: '', utility: pick.fast === pick.best ? '' : `${pid}:${pick.fast}` } });
    return c.json({ id: pid, models: pick });
  }
  const pid = llm.addProvider(body);
  const s = getSettings();
  if (!s.models.chat && body.models?.[0]) saveSettings({ models: { ...s.models, chat: `${pid}:${body.models[0]}` } });
  return c.json({ id: pid });
});
api.patch('/providers/:id', async (c) => (llm.updateProvider(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/providers/:id', (c) => (llm.deleteProvider(c.req.param('id')), c.json({ ok: true })));
// After a model fails: pick the best model from a different provider if there is one.
api.post('/models/auto', async (c) => {
  const { exclude = getSettings().models.chat } = await c.req.json().catch(() => ({}));
  const failedProvider = String(exclude ?? '').split(':')[0];
  const options = llm
    .listProviders()
    .map((p) => ({ p, pick: llm.pickBestModels(p.models) }))
    .filter((o) => o.pick && `${o.p.id}:${o.pick.best}` !== exclude);
  const choice = options.find((o) => o.p.id !== failedProvider) ?? options[0];
  if (!choice?.pick) return c.json({ error: 'No other model is connected. Add one in Settings → AI models.' }, 400);
  const ref = `${choice.p.id}:${choice.pick.best}`;
  const s = getSettings();
  saveSettings({ models: { ...s.models, chat: ref } });
  publish({ type: 'settings.updated' });
  return c.json({ ref, label: `${choice.p.name} · ${choice.pick.best}` });
});
api.post('/conversations/:id/retry', (c) => c.json({ runId: chat.retryLast(c.req.param('id')) }));
api.post('/providers/models', async (c) => c.json({ models: await llm.fetchModelList(await c.req.json()) }));
api.post('/providers/test', async (c) => {
  const { ref } = await c.req.json();
  const started = Date.now();
  const { text } = await generateText({ model: llm.resolveModel(ref), prompt: 'Reply with just the word: ready' });
  return c.json({ ok: true, text: text.slice(0, 100), ms: Date.now() - started });
});

// ── Conversations ─────────────────────────────────────────────────────────────
api.get('/conversations', (c) => c.json(chat.listConversations(c.req.query('project'))));
api.get('/conversations/main', (c) => c.json({ id: chat.mainConversationId() }));
api.post('/conversations', async (c) => {
  const { projectId, text, attachments } = await c.req.json().catch(() => ({}));
  const cid = chat.createConversation(projectId);
  const runId = text || attachments?.length ? await chat.sendMessage(cid, text ?? '', attachments ?? []) : null;
  return c.json({ id: cid, runId });
});
api.get('/conversations/:id', (c) => {
  const conv = chat.getConversation(c.req.param('id'));
  return conv ? c.json(conv) : c.json({ error: 'not found' }, 404);
});
api.patch('/conversations/:id', async (c) => {
  const { title, projectId } = await c.req.json();
  if (title) chat.renameConversation(c.req.param('id'), title);
  if (projectId !== undefined) chat.moveConversation(c.req.param('id'), projectId);
  return c.json({ ok: true });
});
api.delete('/conversations/:id', (c) => (chat.deleteConversation(c.req.param('id')), c.json({ ok: true })));
api.post('/conversations/:id/messages', async (c) => {
  const { text, attachments } = await c.req.json();
  return c.json({ runId: await chat.sendMessage(c.req.param('id'), text ?? '', attachments ?? []) });
});
api.post('/runs/:id/stop', (c) => (chat.stopRun(c.req.param('id')), c.json({ ok: true })));

// ── Memory ────────────────────────────────────────────────────────────────────
api.get('/memories', (c) => c.json(mem.listMemories()));
api.post('/memories', async (c) => {
  const { content, category } = await c.req.json();
  return c.json({ id: mem.addMemory(content, category, 'manual') });
});
api.patch('/memories/:id', async (c) => (mem.updateMemory(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/memories/:id', (c) => (mem.deleteMemory(c.req.param('id')), c.json({ ok: true })));

// ── Projects ──────────────────────────────────────────────────────────────────
api.get('/projects', (c) => c.json(projects.listProjects()));
api.post('/projects', async (c) => c.json({ id: projects.createProject(await c.req.json()) }));
api.get('/projects/:id', (c) => {
  const p = projects.getProject(c.req.param('id'));
  return p ? c.json(p) : c.json({ error: 'not found' }, 404);
});
api.patch('/projects/:id', async (c) => (projects.updateProject(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/projects/:id', (c) => (projects.deleteProject(c.req.param('id')), c.json({ ok: true })));
api.post('/projects/:id/tasks', async (c) => {
  const { title, due } = await c.req.json();
  return c.json({ id: projects.addTask(c.req.param('id'), title, due) });
});
api.post('/projects/:id/files', async (c) => c.json({ id: await projects.addProjectFile(c.req.param('id'), await c.req.json()) }));
api.delete('/project-files/:id', (c) => (projects.deleteProjectFile(c.req.param('id')), c.json({ ok: true })));
api.patch('/tasks/:id', async (c) => (projects.updateTask(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/tasks/:id', (c) => (projects.deleteTask(c.req.param('id')), c.json({ ok: true })));

// ── Vault ─────────────────────────────────────────────────────────────────────
api.get('/vault', (c) => c.json({ ...vault.status(), items: vault.listItems(), fields: vault.VAULT_FIELDS }));
api.post('/vault/setup', async (c) => (vault.setup((await c.req.json()).passphrase), c.json({ ok: true })));
api.post('/vault/unlock', async (c) => (vault.unlock((await c.req.json()).passphrase), c.json({ ok: true })));
api.post('/vault/lock', (c) => (vault.lock(), c.json({ ok: true })));
api.post('/vault/items', async (c) => c.json({ id: vault.addItem(await c.req.json()) }));
api.patch('/vault/items/:id', async (c) => (vault.updateItem(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/vault/items/:id', (c) => (vault.deleteItem(c.req.param('id')), c.json({ ok: true })));
api.post('/vault/items/:id/reveal', async (c) => c.json(vault.revealItem(c.req.param('id'), (await c.req.json()).passphrase ?? '')));

// ── Handoff ───────────────────────────────────────────────────────────────────
api.get('/handoffs', (c) => c.json(handoff.listHandoffs()));
api.get('/handoffs/:id', (c) => {
  const h = handoff.getHandoff(c.req.param('id'));
  return h ? c.json(h) : c.json({ error: 'not found' }, 404);
});
api.post('/handoffs', async (c) => {
  const { goal, startUrl } = await c.req.json();
  const hid = await new Promise<string>((resolve) => {
    handoff.runHandoff({ goal, startUrl, onCreated: resolve }).catch(() => {});
  });
  return c.json({ id: hid });
});
api.post('/handoffs/:id/cancel', (c) => (handoff.cancelHandoff(c.req.param('id')), c.json({ ok: true })));
api.post('/handoffs/:id/steer', async (c) => c.json({ ok: handoff.steerHandoff(c.req.param('id'), (await c.req.json()).text) }));
// The task's screen, streamed only while someone watches it.
api.get('/handoffs/:id/live', (c) =>
  streamSSE(c, async (stream) => {
    const off = live.watch(c.req.param('id'), (f) => void stream.writeSSE({ data: JSON.stringify(f) }).catch(() => {}));
    const ping = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}), 25000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    off();
  }),
);
api.post('/handoffs/:id/control', async (c) => {
  const on = !!(await c.req.json().catch(() => ({}))).on;
  return handoff.controlHandoff(c.req.param('id'), on) ? c.json({ ok: true }) : c.json({ error: 'This task has finished' }, 409);
});
const point = { x: z.number().finite(), y: z.number().finite() };
const button = z.enum(['left', 'right', 'middle']).optional();
const inputEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...point, button, count: z.number().int().min(1).max(3).optional() }),
  z.object({ type: z.literal('move'), ...point }),
  z.object({ type: z.enum(['down', 'up']), ...point, button }),
  z.object({ type: z.literal('wheel'), ...point, dx: z.number().finite(), dy: z.number().finite() }),
  z.object({
    type: z.literal('key'),
    key: z.string().min(1).max(24),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
    meta: z.boolean().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string().max(10_000) }),
]);
api.post('/handoffs/:id/input', async (c) => {
  const hid = c.req.param('id');
  // Only while you have taken over, so a stray click on the live view never fights the agent.
  if (!handoff.getHandoff(hid)?.control) return c.json({ error: 'Take over first' }, 409);
  const parsed = inputEvent.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Bad input' }, 400);
  await live.input(hid, parsed.data);
  return c.json({ ok: true });
});

// ── Approvals & questions ─────────────────────────────────────────────────────
api.get('/pending', (c) => c.json(approvals.listPending()));
api.post('/pending/:id', async (c) => c.json({ ok: approvals.resolvePending(c.req.param('id'), await c.req.json()) }));

// ── Action buttons ────────────────────────────────────────────────────────────
api.get('/actions', (c) => c.json(actions.listActions()));
api.post('/actions/refresh', (c) => {
  void actions.generateActions();
  return c.json({ ok: true });
});
api.post('/actions/:id/run', async (c) => {
  const a = all<actions.ActionRow>('SELECT * FROM actions WHERE id = ?', c.req.param('id'))[0];
  if (!a) return c.json({ error: 'not found' }, 404);
  actions.setActionStatus(a.id, 'done');
  const cid = chat.mainConversationId();
  if (chat.activeRunFor(cid)) return c.json({ error: 'Errand is still working on the previous message' }, 409);
  const runId = await chat.sendMessage(cid, a.prompt);
  return c.json({ conversationId: cid, runId });
});
api.post('/actions/:id/dismiss', (c) => (actions.setActionStatus(c.req.param('id'), 'dismissed'), c.json({ ok: true })));

// ── Panels ────────────────────────────────────────────────────────────────────
api.get('/panels', (c) => c.json(panels.listPanels().map(({ html: _h, ...p }) => p)));
// Panels render in a sandboxed iframe from this endpoint with a strict CSP: inline code may run,
// but it cannot make network requests, so a panel can't leak the data it displays.
api.get('/panels/:id/frame', (c) => {
  const p = panels.getPanel(c.req.param('id'));
  if (!p) return c.text('Not found', 404);
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; sandbox allow-scripts",
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Cache-Control', 'no-store');
  return c.html(panels.renderPanel(p, c.req.query('theme') === 'light' ? 'light' : 'dark'));
});
api.post('/panels', async (c) => c.json(await panels.createPanel((await c.req.json()).request)));
api.post('/panels/:id/refresh', (c) => {
  void panels.refreshPanel(c.req.param('id'));
  return c.json({ ok: true });
});
api.post('/panels/:id/edit', async (c) => {
  await panels.editPanel(c.req.param('id'), (await c.req.json()).instruction);
  return c.json({ ok: true });
});
api.patch('/panels/:id', async (c) => (panels.updatePanel(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/panels/:id', (c) => (panels.deletePanel(c.req.param('id')), c.json({ ok: true })));

// ── Routines ──────────────────────────────────────────────────────────────────
api.get('/routines', (c) => c.json(routines.listRoutines().map((r) => ({ ...r, description: routines.describeSchedule(r.schedule) }))));
api.post('/routines', async (c) => c.json({ id: routines.createRoutine(await c.req.json()) }));
api.patch('/routines/:id', async (c) => (routines.updateRoutine(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/routines/:id', (c) => (routines.deleteRoutine(c.req.param('id')), c.json({ ok: true })));
api.post('/routines/:id/run', async (c) => c.json({ conversationId: await routines.runRoutine(c.req.param('id')) }));
api.post('/notifications/test', async (c) => (await notify({ title: 'Errand test notification', body: 'Notifications are working.' }), c.json({ ok: true })));

// ── MCP integrations ──────────────────────────────────────────────────────────
api.get('/mcp', (c) => c.json(mcp.listServers()));
api.post('/mcp', async (c) => c.json({ id: await mcp.addServer(await c.req.json()) }));
api.patch('/mcp/:id', async (c) => (await mcp.updateServer(c.req.param('id'), await c.req.json()), c.json({ ok: true })));
api.delete('/mcp/:id', async (c) => (await mcp.removeServer(c.req.param('id')), c.json({ ok: true })));

// ── Connections, weather, voice ───────────────────────────────────────────────
// ── Accounts: mailboxes, Google sign-in, calendars ────────────────────────────
api.get('/accounts/email', (c) => c.json(email.listAccounts()));
api.post('/accounts/email', async (c) => {
  const body = await c.req.json();
  const accountId = await email.addImapAccount(body);
  void runBrief('a mailbox was connected', body.address).then(() => scanMail());
  return c.json({ id: accountId });
});
// ── Things Errand noticed in email: trackers ───────────────────────────────────
api.get('/trackers', (c) => c.json(trackerSummary()));
api.post('/trackers/scan', async (c) => c.json(await scanMail()));
api.patch('/trackers/items/:id', async (c) => c.json(updateTracked(c.req.param('id'), await c.req.json()) && { ok: true }));
api.post('/brief', async (c) => c.json({ conversationId: await runBrief('the user asked for a catch-up') }));
api.post('/accounts/email/:id/test', async (c) => c.json(await email.testAccount(c.req.param('id'))));
api.delete('/accounts/email/:id', (c) => (email.removeAccount(c.req.param('id')), c.json({ ok: true })));
api.post('/accounts/calendar/test', async (c) => c.json({ events: (await listEvents()).slice(0, 5) }));

// Top-level navigations (GET), so the browser can follow Google's redirects.
api.get('/oauth/google/start', (c) => {
  try {
    return c.redirect(google.authUrl(c.req.query('hint')));
  } catch (err) {
    return c.redirect(`/#/settings/accounts?error=${encodeURIComponent((err as Error).message)}`);
  }
});
api.get('/oauth/google/callback', async (c) => {
  const error = c.req.query('error');
  try {
    if (error) throw new Error(`Google: ${error}`);
    const { email: address, name, refreshToken } = await google.handleCallback(c.req.query('code') ?? '', c.req.query('state') ?? '');
    email.upsertGoogleAccount(address, name, refreshToken);
    void runBrief('a Google account was connected', address).then(() => scanMail());
    if (!isOnboarded()) {
      setKV('onboarding.done', '1');
      return c.redirect('/#/chat');
    }
    return c.redirect(`/#/settings/accounts?connected=${encodeURIComponent(address)}`);
  } catch (err) {
    return c.redirect(`/#/settings/accounts?error=${encodeURIComponent((err as Error).message)}`);
  }
});

// "Continue with Microsoft" for Outlook, Hotmail and Microsoft 365 mail.
api.get('/oauth/microsoft/start', (c) => {
  try {
    return c.redirect(microsoft.microsoftAuthUrl(c.req.query('hint')));
  } catch (err) {
    return c.redirect(`/#/settings/accounts?error=${encodeURIComponent((err as Error).message)}`);
  }
});
api.get('/oauth/microsoft/callback', async (c) => {
  try {
    const error = c.req.query('error_description') ?? c.req.query('error');
    if (error) throw new Error(`Microsoft: ${error}`);
    const { address, name, refreshToken } = await microsoft.microsoftCallback(c.req.query('code') ?? '', c.req.query('state') ?? '');
    email.upsertMicrosoftAccount(address, name, refreshToken);
    void runBrief('a Microsoft account was connected', address).then(() => scanMail());
    if (!isOnboarded()) {
      setKV('onboarding.done', '1');
      return c.redirect('/#/chat');
    }
    return c.redirect(`/#/settings/accounts?connected=${encodeURIComponent(address)}`);
  } catch (err) {
    return c.redirect(`/#/settings/accounts?error=${encodeURIComponent((err as Error).message)}`);
  }
});

// "Continue with ChatGPT": the callback lands on /callback (see index.ts), as the flow requires.
api.get('/oauth/chatgpt/start', (c) => ((signInFrom = c.req.query('from') ?? ''), c.redirect(chatgpt.startSignIn())));

api.get('/oauth/openrouter/start', (c) => ((signInFrom = c.req.query('from') ?? ''), c.redirect(openrouter.startOpenRouter(new URL(c.req.url).origin))));
api.get('/oauth/openrouter/callback', async (c) => {
  try {
    const key = await openrouter.finishOpenRouter(c.req.query('code') ?? '', c.req.query('state') ?? '');
    const baseUrl = 'https://openrouter.ai/api/v1';
    const models = await llm.fetchModelList({ kind: 'openai-compatible', baseUrl, apiKey: key }).catch(() => [] as string[]);
    const pid = llm.addProvider({ kind: 'openai-compatible', name: 'OpenRouter', baseUrl, apiKey: key, models });
    const s = getSettings();
    const pick = llm.pickBestModels(models.filter((m) => /^(openai|anthropic|google)\//.test(m))) ?? llm.pickBestModels(models);
    if (!s.models.chat && pick) saveSettings({ models: { ...s.models, chat: `${pid}:${pick.best}`, utility: s.models.utility || `${pid}:${pick.fast}` } });
    publish({ type: 'settings.updated' });
    return c.redirect(afterModelSignIn('openrouter', pid));
  } catch (err) {
    return c.redirect(`/#/settings/models?error=${encodeURIComponent((err as Error).message)}`);
  }
});

// Files Errand made or collected. HTML (presentations) runs sandboxed with no access to the app.
api.get('/files/:id', (c) => {
  const f = readStoredFile(c.req.param('id'));
  if (!f) return c.text('Not found', 404);
  c.header('Content-Type', f.mime);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'private, max-age=3600');
  if (f.mime === 'text/html')
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts",
    );
  const inline = /^(text\/html|image\/(png|jpeg)|application\/pdf|text\/plain)/.test(f.mime);
  c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/"/g, '')}"`);
  return c.body(fs.readFileSync(f.path));
});

// Your data: take it with you, or delete all of it.
api.get('/data/export', (c) => {
  c.header('Content-Disposition', `attachment; filename="errand-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(exportAllData());
});
// Errand keeps running in the background after its window closes (to notice things and run
// routines); this is the way to stop it. Not from the phone, which couldn't start it again.
api.post('/quit', (c) => {
  if (fromPhone(c)) return c.json({ error: 'Not available from the phone' }, 403);
  quitSoon(300);
  return c.json({ ok: true });
});
// Start Errand quietly when you log in (Windows Run key, Mac LaunchAgent, Linux autostart).
api.get('/startup', (c) => c.json({ available: canStartAtLogin(), on: startsAtLogin() }));
api.put('/startup', async (c) => {
  if (fromPhone(c)) return c.json({ error: 'Change this on your computer' }, 403);
  const { on } = await c.req.json();
  if (!setStartsAtLogin(!!on)) return c.json({ error: 'This copy of Errand was not installed with the installer, so it cannot start at login.' }, 400);
  return c.json({ on: startsAtLogin() });
});
// The Errand icon (Errand.exe) asks the running Errand to show its window again.
api.post('/window', (c) => {
  if (fromPhone(c)) return c.json({ error: 'Not available from the phone' }, 403);
  openApp(`http://127.0.0.1:${PORT}`);
  return c.json({ ok: true });
});

api.post('/data/delete-all', async (c) => {
  const { confirm } = await c.req.json();
  if (confirm !== 'DELETE') return c.json({ error: 'Type DELETE to confirm' }, 400);
  await deleteAllData();
  return c.json({ ok: true });
});

api.get('/search', (c) => c.json(searchConversations(c.req.query('q') ?? '')));
api.get('/weather', async (c) => c.json(await getWeather()));
api.get('/geocode', async (c) => c.json(await geocode(c.req.query('q') ?? '')));

api.post('/transcribe', async (c) => {
  const row = all<{ api_key: string; base_url: string | null }>(
    "SELECT api_key, base_url FROM providers WHERE kind = 'openai' AND api_key IS NOT NULL LIMIT 1",
  )[0];
  if (!row) return c.json({ error: 'Server transcription needs an OpenAI provider. Your browser’s built-in speech recognition is used otherwise.' }, 400);
  const form = await c.req.formData();
  const file = form.get('audio') as File | null;
  if (!file) return c.json({ error: 'no audio' }, 400);
  const openai = createOpenAI({ apiKey: unseal(row.api_key), baseURL: row.base_url || undefined });
  const result = await transcribe({ model: openai.transcription('gpt-4o-mini-transcribe'), audio: new Uint8Array(await file.arrayBuffer()) });
  return c.json({ text: result.text });
});

/** Setup is finished once the user completes or skips it (older installs: a model and a mailbox). */
export function isOnboarded() {
  return getKV('onboarding.done') === '1' || (llm.hasModel() && email.listAccounts().length > 0);
}

// Where the last model sign-in started, so it returns there (one user, one sign-in at a time).
let signInFrom = '';

/**
 * Where to land after a model sign-in: setup if unfinished, else Settings. A sign-in started from chat
 * switches chat to the new account and returns there; one started under a failed reply ("retry:<id>")
 * also runs that message again.
 */
export function afterModelSignIn(provider: string, pid: string) {
  const from = signInFrom;
  signInFrom = '';
  if (!isOnboarded()) return '/#/';
  const retry = from.startsWith('retry:') ? from.slice(6) : '';
  if (from !== 'chat' && !retry) return `/#/settings/models?connected=${provider}`;
  const models = llm.listProviders().find((p) => p.id === pid)?.models ?? [];
  const pick = llm.pickBestModels(models.filter((m) => /^(openai|anthropic|google)\//.test(m))) ?? llm.pickBestModels(models);
  if (pick) saveSettings({ models: { ...getSettings().models, chat: `${pid}:${pick.best}` } });
  publish({ type: 'settings.updated' });
  const main = chat.mainConversationId();
  const cid = retry || main;
  const ref = getSettings().models.chat;
  chat.recordEvent(cid, `${provider === 'chatgpt' ? 'ChatGPT' : 'OpenRouter'} connected${ref ? `. ${llm.modelLabel(ref)} is answering now` : ''}`, 'cpu');
  if (retry) {
    try {
      chat.retryLast(retry);
    } catch {
      // Already answering, or nothing to retry: the note above is enough.
    }
  }
  return cid === main ? '/#/chat' : `/#/c/${cid}`;
}
