/**
 * End-to-end test: starts a scripted model and a real Errand server on a throwaway data
 * directory, then drives everything through the HTTP API the web app uses.
 *
 *   npm run test:e2e
 *
 * Browser-agent checks need Chrome or Edge installed; they're skipped (with a warning) otherwise.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockModel } from './mock-model.ts';
import { email, startMockMail } from './mock-mail.ts';

const APP_PORT = 4790;
const MODEL_PORT = 4791;
const PHONE_PORT = 4792;
const MAIL_PORT = 4793;
const BASE = `http://localhost:${APP_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'errand-e2e-'));

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const headers = { 'content-type': 'application/json', 'x-errand': '1' };
async function api(p: string, body?: unknown, method?: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}/api${p}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data: any = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* plain text */
  }
  return { status: res.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const model = await startMockModel(MODEL_PORT);
const mail = await startMockMail(MAIL_PORT);
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, ERRAND_PORT: String(APP_PORT), ERRAND_DATA_DIR: dataDir, ERRAND_HEADLESS: '1', ERRAND_PHONE_PORT: String(PHONE_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${BASE}/api/status`).catch(() => null))?.ok) break;
    await sleep(500);
  }
  check('server starts', (await api('/status')).status === 200);

  // Connect the scripted model the same way a user adds an OpenAI-compatible provider.
  const first = (await api('/providers', { kind: 'openai-compatible', name: 'Test model', baseUrl: `http://localhost:${MODEL_PORT}/v1`, models: ['mock-1'] }))
    .data;
  check('model connected', (await api('/status')).data.hasModel === true);
  const main = (await api('/conversations/main')).data.id as string;

  /** Send a message to the main thread, answer approvals/codes as they come, wait for the reply. */
  async function say(text: string, answers: { code?: string } = {}) {
    await api(`/conversations/${main}/messages`, { text });
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      for (const p of (await api('/pending')).data as any[]) {
        await api(`/pending/${p.id}`, { approved: true, text: p.kind === 'code' ? (answers.code ?? '') : '' });
      }
      const conv = (await api(`/conversations/${main}`)).data;
      if (!conv.activeRun) return conv.messages as any[];
    }
    throw new Error(`no reply to "${text}"`);
  }
  const toolOutput = (messages: any[], name: string) => {
    for (const m of [...messages].reverse()) if (m.role === 'tool') for (const p of m.content) if (p.toolName === name) return p.output?.value ?? p.output;
    return null;
  };
  const allText = (messages: any[]) => JSON.stringify(messages);

  // ── Chat-driven features ────────────────────────────────────────────────
  let msgs = await say('make me a presentation of my usage');
  const deck = toolOutput(msgs, 'make_presentation');
  check('presentation created', !!deck?.file?.url);
  if (deck?.file?.url) {
    const res = await fetch(BASE + deck.file.url);
    const csp = res.headers.get('content-security-policy') ?? '';
    check('presentation is sandboxed', csp.includes('sandbox') && csp.includes("default-src 'none'"));
    check('presentation has slides and a chart', ((await res.text()).match(/class="slide/g) ?? []).length === 3);
  }

  msgs = await say('connect my work gmail');
  check('connect_account shows a button', !!toolOutput(msgs, 'connect_account')?.action?.url);

  msgs = await say('brief me every morning at 8');
  check('routine scheduled from chat', toolOutput(msgs, 'routine_create')?.schedule === 'Every day at 08:00');

  await say('pause my morning brief');
  check(
    'routine paused from chat',
    ((await api('/routines')).data as any[]).every((r) => !r.enabled),
  );

  await api('/providers', { kind: 'openai-compatible', name: 'Mini model', baseUrl: `http://localhost:${MODEL_PORT}/v1`, models: ['mock-1-mini'] });
  await say('use mock-1-mini for everything');
  check('model switched from chat', String((await api('/settings')).data.models.chat).endsWith(':mock-1-mini'));

  await say('this is how i do returns: refund, never store credit, and email me the label');
  check(
    'a specialty is saved from chat',
    ((await api('/memories')).data as any[]).some((m) => m.category === 'specialty' && /Product returns/.test(m.content)),
  );

  await say('remind me to pay the electricity bill');
  check(
    'action button pinned from chat',
    ((await api('/actions')).data as any[]).some((a) => /electricity/.test(a.title)),
  );
  await say('i already paid it');
  check('action button cleared from chat', !((await api('/actions')).data as any[]).some((a) => /electricity/.test(a.title)));

  await api('/panels', { request: 'the answer' });
  await say('make the answer panel bigger');
  check('panel changed from chat', ((await api('/panels')).data as any[])[0]?.size === 'lg');

  await say('i moved to denver');
  check('settings changed from chat', /Denver/.test((await api('/settings')).data.location?.name ?? ''));

  msgs = await say('what version am I on?');
  check('version and updates from chat', toolOutput(msgs, 'app_about')?.version === JSON.parse(fs.readFileSync('package.json', 'utf8')).version);

  msgs = await say('remember my favourite colour');
  check(
    'memory saved',
    ((await api('/memories')).data as any[]).some((m) => /blue/i.test(m.content)),
  );

  // ── Browser agent: vault login, approval gate, OTP ──────────────────────
  await api('/vault/setup', { passphrase: 'e2e-passphrase' });
  await api('/vault/items', { kind: 'login', label: 'Test shop', domain: 'localhost', fields: { username: 'me@example.com', password: 'super-secret-pw' } });
  msgs = await say('please order the blue mug');
  const order = toolOutput(msgs, 'handoff');
  if (/Could not start the browser/.test(order?.result ?? '')) {
    console.log('! browser-agent checks skipped: no Chrome/Edge found');
  } else {
    check('browser agent completes the order', order?.status === 'done' && /Order confirmed #A123/.test(order?.result ?? ''), order?.result);
    check('approval was recorded in the timeline', /You approved: /.test(allText(msgs)));
    const db = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith('errand.db'))
      .map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1'))
      .join('');
    check('vault password never stored in plaintext', !db.includes('super-secret-pw'));

    // ── Live view, take-over and uploads ────────────────────────────────
    // A CV attached in chat is kept as a file the browser agent can upload.
    await api(`/conversations/${main}/messages`, {
      text: 'here is my cv',
      attachments: [{ name: 'cv.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') }],
    });
    for (let i = 0; i < 40 && (await api(`/conversations/${main}`)).data.activeRun; i++) await sleep(250);
    const task = (await api('/handoffs', { goal: 'TAKEOVER test: upload my CV and wait for me' })).data.id as string;
    const liveRes = await fetch(`${BASE}/api/handoffs/${task}/live`);
    const reader = liveRes.body!.getReader();
    let firstFrame: any = null;
    for (let buf = ''; !firstFrame;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const m = buf.match(/data: (\{.*\})\n/);
      if (m) firstFrame = JSON.parse(m[1]);
    }
    await reader.cancel();
    check('live view streams the task’s screen', /^\/9j\//.test(firstFrame?.image ?? '') && firstFrame.width > 0, firstFrame?.url);
    for (let i = 0; i < 40; i++) {
      if (((await api(`/handoffs/${task}`)).data.steps as any[]).some((st) => st.action === 'upload')) break;
      await sleep(250);
    }
    const uploaded = ((await api(`/handoffs/${task}`)).data.steps as any[]).find((st) => st.action === 'upload');
    check('browser agent uploads a file from chat', /attached cv\.pdf/.test(uploaded?.detail ?? ''), uploaded?.detail);
    check('input is refused until you take over', (await api(`/handoffs/${task}/input`, { type: 'text', text: 'x' })).status === 409);
    check('you can take over', (await api(`/handoffs/${task}/control`, { on: true })).data.ok === true);
    check('the task shows you are in control', (await api(`/handoffs/${task}`)).data.control === true);
    await sleep(1500); // the agent finishes the step it was on, then waits for you
    await api(`/handoffs/${task}/input`, { type: 'click', x: 0.5, y: 0.75 });
    await api(`/handoffs/${task}/input`, { type: 'text', text: 'hello' });
    await api(`/handoffs/${task}/control`, { on: false });
    let finished: any = null;
    for (let i = 0; i < 60 && !finished; i++) {
      await sleep(500);
      const h = (await api(`/handoffs/${task}`)).data;
      if (!['queued', 'running', 'waiting'].includes(h.status)) finished = h;
    }
    check('what you typed while in control reaches the page', /Typed: hello/.test(finished?.result ?? ''), finished?.result);
    check('the agent carries on after you hand back', finished?.status === 'done' && /File: cv\.pdf/.test(finished?.result ?? ''));
    check('the final screen is kept', typeof finished?.frame === 'string' && finished.frame.length > 1000);

    msgs = await say('log me in, it needs an otp', { code: '482913' });
    check('OTP code reaches the site', /Logged in with code 482913/.test(toolOutput(msgs, 'handoff')?.result ?? ''));
    check('code request recorded in timeline', /code submitted/.test(allText(msgs)));
  }

  // ── Setup flow and model choice ─────────────────────────────────────────
  check('setup is unfinished until completed', (await api('/status')).data.onboarded === false);
  await api('/onboarding/done', {});
  check('setup can be completed', (await api('/status')).data.onboarded === true);
  const auto = await api('/providers', { kind: 'openai-compatible', name: 'Auto test', baseUrl: `http://localhost:${MODEL_PORT}/v1`, auto: true });
  check('best models picked automatically', auto.data.models?.best === 'mock-1' && auto.data.models?.fast === 'mock-1-mini', JSON.stringify(auto.data.models));
  check('chat switches to the picked model', (await api('/settings')).data.models.chat === `${auto.data.id}:mock-1`);
  const switched = await api('/models/auto', {});
  check(
    '"switch automatically" moves to another provider',
    switched.status === 200 && !String(switched.data.ref).startsWith(auto.data.id),
    switched.data.label,
  );
  const before = (await api(`/conversations/${main}`)).data.messages.length;
  await api(`/conversations/${main}/retry`, {});
  for (let i = 0; i < 120 && (await api(`/conversations/${main}`)).data.activeRun; i++) {
    for (const p of (await api('/pending')).data as any[]) await api(`/pending/${p.id}`, { approved: true, text: p.kind === 'code' ? '482913' : '' });
    await sleep(500);
  }
  const after = (await api(`/conversations/${main}`)).data.messages.length;
  check('retry runs the last message again without repeating it', after > before && after - before <= 4, `${before} → ${after}`);

  // ── Model fallback ──────────────────────────────────────────────────────
  const busy = await api('/providers', { kind: 'openai-compatible', name: 'Busy model', baseUrl: `http://localhost:${MODEL_PORT}/v1`, models: ['mock-busy'] });
  await api('/settings', { models: { chat: `${busy.data.id}:mock-busy`, handoff: '', utility: '' } }, 'PUT');
  const fell = await say('what can you do for me?');
  const reply = fell.findLast((m) => m.role === 'assistant' && m.kind !== 'event');
  check('a busy model falls back to another one', !!reply && !allText([reply]).includes('⚠️'), allText([reply ?? {}]).slice(0, 80));
  check('the switch is noted in the timeline', /Busy model · mock-busy was busy, so .+ answered/.test(allText(fell)));

  // ── Security guards ─────────────────────────────────────────────────────
  check(
    'writes without X-Errand are refused',
    (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status === 403,
  );
  check(
    'cross-origin writes are refused',
    (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{"name":"x"}' })).status === 403,
  );
  const shell = await fetch(`${BASE}/api/status`);
  check('security headers present', shell.headers.get('x-frame-options') === 'DENY');
  const settings = (await api('/settings')).data;
  check('settings never expose secrets', settings.google.clientSecret === '' && settings.search.apiKey === '');
  // ── Continue with Microsoft ─────────────────────────────────────────────
  check('Microsoft sign-in is off until a client id is set', (await api('/settings')).data.microsoft?.ready === false);
  await api('/settings', { microsoft: { clientId: 'e2e-client' } }, 'PUT');
  const msStart = await fetch(`${BASE}/api/oauth/microsoft/start`, { redirect: 'manual' });
  check(
    'Microsoft sign-in starts at Microsoft with PKCE',
    (await api('/settings')).data.microsoft?.ready === true &&
      /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?.*code_challenge=/.test(msStart.headers.get('location') ?? ''),
  );

  // ── Noticing things in email (a real IMAP mailbox) ──────────────────────
  await api('/settings', { models: { chat: `${first.id}:mock-1`, handoff: '', utility: '' } }, 'PUT');
  const box = await api('/accounts/email', {
    address: 'sam@example.com',
    displayName: 'Sam',
    imapHost: '127.0.0.1',
    imapPort: MAIL_PORT,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: 1,
    smtpSecure: false,
    password: 'app-password',
  });
  check('a mailbox connects over IMAP', box.status === 200, JSON.stringify(box.data).slice(0, 120));
  await api('/trackers/scan', {});
  const trackers = async () => Object.fromEntries(((await api('/trackers')).data as any[]).map((t) => [t.id, t]));
  let t = await trackers();
  for (let i = 0; i < 40 && !t.jobs?.total; i++) (await sleep(500), (t = await trackers()));
  const item = (tracker: string, title: string) => t[tracker]?.items.find((x: any) => x.title === title);
  check('applications are tracked from replies', item('jobs', 'Raycast')?.status === 'received');
  check('applications you emailed are tracked too', item('jobs', 'Gradsiren')?.label === 'Emailed, awaiting reply', JSON.stringify(t.jobs?.items));
  check(
    'orders, bills and trips are tracked',
    item('orders', 'Amazon')?.status === 'shipped' && item('bills', 'Airtel')?.status === 'due' && item('trips', 'IndiGo')?.status === 'booked',
  );
  check('promotions are ignored', !JSON.stringify(t).includes('Myntra'));
  const buttons = ((await api('/actions')).data as any[]).map((a) => `${a.title} | ${a.description}`);
  check(
    'a failing CI run becomes a button',
    buttons.some((b) => /^Fix the failing CI on acme-e2e\/shop \| 3 runs on main failed/.test(b)),
    buttons.join('; '),
  );
  check(
    'a bill due soon becomes a button',
    buttons.some((b) => b.startsWith('Pay the Airtel bill')),
  );
  check(
    'a flight tomorrow becomes a check-in button',
    buttons.some((b) => b.startsWith('Check in for 6E 512')),
  );
  check(
    'a flight with no hotel gets a stay button',
    buttons.some((b) => b.startsWith('Book a place to stay in Goa')),
  );
  check(
    'a to-do in email becomes a button',
    buttons.some((b) => b.startsWith('Approve Priya’s expense report | Expensify, by')),
    buttons.join('; '),
  );
  const said = () => api(`/conversations/${main}`).then((r) => allText(r.data.messages));
  check(
    'a weekly order habit is noticed and remembered',
    ((await api('/memories')).data as any[]).some((m) => /Usually orders from Zomato on \w+days/.test(m.content)),
  );
  check(
    'the habit gets a timely nudge',
    buttons.some((b) => b.startsWith('Reorder your usual from Zomato')) && /You usually order from \*\*Zomato\*\*/.test(await said()),
  );
  check('the first look is summed up in chat', /I went through your email/.test(await said()));
  mail.append(
    email({
      from: 'Raycast <no-reply@greenhouse.io>',
      subject: 'Raycast: interview invitation',
      body: 'We would love to talk. Pick a time for your first interview.',
      at: Date.now(),
    }),
  );
  await api('/trackers/scan', {});
  t = await trackers();
  check('a new email updates the tracker', item('jobs', 'Raycast')?.status === 'interview' && t.jobs.today >= 1);
  check('the change is posted in chat', /Raycast moved your application to \*\*Interview\*\*/.test(await said()));
  check(
    'an interview gets a prep offer',
    ((await api('/actions')).data as any[]).some((a) => a.title === 'Prep for the Raycast interview'),
  );
  const again = (await api('/trackers/scan', {})).data;
  check('the same emails are never handled twice', again.looked === 0, JSON.stringify(again));

  // ── Use on your phone ───────────────────────────────────────────────────
  const phone = (await api('/phone', { enabled: true })).data;
  check('phone access gives a code and a QR code', /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(phone.code) && String(phone.qr).startsWith('<svg'));
  const onPhone = (p: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${PHONE_PORT}/api${p}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  const locked = await onPhone('/status');
  check('the phone needs the code', locked.status === 401 && (await locked.json()).phone === true);
  check('a wrong code is refused', (await onPhone('/login', { method: 'POST', body: '{"password":"aaaa-bbbb-cccc"}' })).status === 401);
  const login = await onPhone('/login', { method: 'POST', body: JSON.stringify({ password: ` ${phone.code.toUpperCase()} ` }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const phoneStatus = await onPhone('/status', { headers: { cookie } });
  check('the code signs the phone in', login.status === 200 && phoneStatus.status === 200 && (await phoneStatus.json()).phone === true);
  check('the phone cannot read or change phone access', (await onPhone('/phone', { headers: { cookie } })).status === 403);
  const post = (p: string, body: unknown, method = 'POST') => onPhone(p, { method, headers: { cookie }, body: JSON.stringify(body) });
  check(
    'the phone cannot run programs, open folders or export everything',
    (await post('/mcp', { name: 'x', transport: 'stdio', command: 'calc' })).status === 403 &&
      (await post('/settings', { handoff: { executablePath: 'C:/Windows/System32/calc.exe' } }, 'PUT')).status === 403 &&
      (await post('/settings', { files: { roots: ['C:/'] } }, 'PUT')).status === 403 &&
      (await onPhone('/data/export', { headers: { cookie } })).status === 403,
  );
  check('the phone can still change everyday settings', (await post('/settings', { voice: { speakReplies: false } }, 'PUT')).status === 200);
  await api('/phone', { enabled: true, newCode: true });
  check('a new code signs phones out', (await onPhone('/status', { headers: { cookie } })).status === 401);
  await api('/phone', { enabled: false });
  check(
    'turning it off closes the phone port',
    await onPhone('/status').then(
      () => false,
      () => true,
    ),
  );

  check('delete-all needs typed confirmation', (await api('/data/delete-all', { confirm: 'no' })).status === 400);
  check('delete-all works', (await api('/data/delete-all', { confirm: 'DELETE' })).status === 200 && ((await api('/memories')).data as any[]).length === 0);
} catch (err) {
  failed++;
  console.error('✗ e2e crashed:', err, '\n--- server log ---\n', serverLog.slice(-3000));
} finally {
  server.kill();
  model.close();
  mail.close();
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failed) console.log(`\n--- server log (end) ---\n${serverLog.slice(-4000)}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall end-to-end checks passed');
process.exit(failed ? 1 : 0);
