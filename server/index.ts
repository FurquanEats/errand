import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { HOST, PASSWORD, PORT, WEB_DIST } from './config.ts';
import { afterModelSignIn, api } from './routes.ts';
import { connectAll } from './connectors/mcp.ts';
import { generateActions } from './actions.ts';
import { refreshDuePanels } from './panels.ts';
import { getSettings } from './settings.ts';
import { closeBrowser } from './handoff/browser.ts';
import { run } from './db.ts';
import { runDueRoutines } from './routines.ts';
import { noticeTick, scanMail } from './trackers.ts';
import { migrateLegacySettings } from './connectors/email.ts';
import { getKV } from './settings.ts';
import { CALLBACK_PATH, finishSignIn } from './connectors/chatgpt.ts';
import { repairChatGPTModels, upsertChatGPTProvider } from './llm.ts';
import { publish } from './bus.ts';
import { initPhone } from './phone.ts';
import { openApp } from './open.ts';
import { announceUpdate } from './updates.ts';
import { mainConversationId, postAssistantMessage } from './chat.ts';

const app = new Hono();
const appHeaders = secureHeaders({
  xFrameOptions: 'DENY', // nobody can frame Errand to trick you into clicking "Approve"
  referrerPolicy: 'no-referrer',
  crossOriginResourcePolicy: 'same-origin',
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    frameSrc: ["'self'"],
    mediaSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
  },
});
// Panel frames and generated files carry their own, stricter sandbox CSP (set in routes.ts).
const ownHeaders = /^\/api\/(panels\/[^/]+\/frame|files\/[^/]+)$/;
app.use('*', (c, next) => (ownHeaders.test(c.req.path) ? next() : appHeaders(c, next)));
app.route('/api', api);

// OAuth loopback callback for "Continue with ChatGPT" (must be http://127.0.0.1:<port>/callback).
app.get(CALLBACK_PATH, async (c) => {
  try {
    const pid = await upsertChatGPTProvider(await finishSignIn(c.req.query()));
    publish({ type: 'settings.updated' });
    return c.redirect(afterModelSignIn('chatgpt', pid));
  } catch (err) {
    return c.redirect(`/#/settings/models?error=${encodeURIComponent((err as Error).message)}`);
  }
});

// Serve the built web app (npm run build). In development Vite serves it on :5173.
if (fs.existsSync(WEB_DIST)) {
  const root = path.relative(process.cwd(), WEB_DIST);
  // Hashed assets can be cached forever; the HTML shell must always be revalidated so updates show up.
  const cacheHeaders = (file: string, c: { header: (k: string, v: string) => void }) =>
    c.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
  app.use('/*', serveStatic({ root, onFound: cacheHeaders }));
  app.get('*', serveStatic({ path: path.join(root, 'index.html'), onFound: cacheHeaders }));
}

migrateLegacySettings(JSON.parse(getKV('app') ?? '{}').email);

// Handoffs interrupted by a restart can't resume.
run("UPDATE handoffs SET status = 'failed', result = 'Interrupted by restart' WHERE status IN ('queued','running','waiting')");

initPhone(app.fetch);
announceUpdate((text) => postAssistantMessage(mainConversationId(), text));

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Errand is running at ${fs.existsSync(WEB_DIST) ? url : 'http://localhost:5173 (dev)'}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) {
    console.warn('  ⚠  Listening beyond localhost without ERRAND_PASSWORD. Anyone on your network can use your assistant.');
  }
  // The launchers set ERRAND_OPEN=1. 127.0.0.1 (not localhost) is the origin sign-in with ChatGPT returns to.
  if (process.env.ERRAND_OPEN === '1') openApp(`http://127.0.0.1:${PORT}`);
});
// Clicking the icon while Errand already runs in the background just opens its window again.
// If the running one is quitting (503, or the port frees up), wait and take over the port.
let retries = 0;
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`  Errand could not start: ${err.message}`);
    process.exit(1);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/api/status`).catch(() => null);
  if (res?.ok) {
    if (process.env.ERRAND_OPEN === '1') openApp(`http://127.0.0.1:${PORT}`);
    console.error('  Errand is already running.');
    process.exit(0);
  }
  if (++retries > 30) {
    console.error(`  Errand could not start: port ${PORT} is in use by another program. Set ERRAND_PORT to use another port.`);
    process.exit(1);
  }
  setTimeout(() => server.listen(PORT, HOST), 500);
});

void connectAll();
void repairChatGPTModels().catch(() => {});

// Background work: notice things in new mail, refresh panels and proactive action buttons.
let lastActions = 0;
let lastScan = 0;
const noticing = () => {
  const p = getSettings().proactive;
  if (!p.enabled || !p.email) return;
  noticeTick();
  if (Date.now() - lastScan > 15 * 60_000) {
    lastScan = Date.now();
    void scanMail().catch((err) => console.warn('[noticed]', err.message));
  }
};
setInterval(async () => {
  noticing();
  await refreshDuePanels().catch(() => {});
  const p = getSettings().proactive;
  if (p.enabled && Date.now() - lastActions > p.intervalMinutes * 60_000) {
    lastActions = Date.now();
    await generateActions();
  }
}, 5 * 60_000);
setTimeout(() => {
  if (getSettings().proactive.enabled) {
    lastActions = Date.now();
    void generateActions();
  }
  void refreshDuePanels();
  noticing();
}, 15_000);

setInterval(() => void runDueRoutines().catch(() => {}), 60_000);

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
