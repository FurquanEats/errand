import crypto from 'node:crypto';
import os from 'node:os';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { renderSVG } from 'uqr';
import { PHONE_PORT } from './config.ts';
import { seal, unseal } from './crypto.ts';
import { getKV, setKV } from './settings.ts';

/**
 * "Use on your phone": a second listener on the network, separate from the loopback one, that
 * always requires the phone code. Scanning the QR code opens Errand on the phone and signs in.
 */

type Fetch = (req: Request, env: Record<string, unknown>) => Response | Promise<Response>;
let fetcher: Fetch | null = null;
let server: Server | null = null;

export const phoneEnabled = () => getKV('phone.enabled') === '1';
export const phoneCode = () => unseal(getKV('phone.code'));

// Easy to read aloud and type: no 0/o, 1/l/i. 12 characters ≈ 59 bits, with login throttling on top.
function newCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.randomBytes(12)]
    .map((b) => alphabet[b % alphabet.length])
    .join('')
    .replace(/(.{4})(?!$)/g, '$1-');
}

/** Addresses a phone can use: the home network, and Tailscale (100.64.0.0/10) if it's installed. */
function addresses() {
  const out: { label: string; url: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y >= 64 && y < 128;
      const home = x === 192 || x === 10 || (x === 172 && y >= 16 && y < 32);
      if (!tailscale && (!home || /vEthernet|WSL|VirtualBox|VMware|docker|br-/i.test(name))) continue;
      out.push({ label: tailscale ? 'Anywhere, with Tailscale' : 'On the same Wi-Fi', url: `http://${a.address}:${PHONE_PORT}` });
    }
  }
  return out.sort((a, b) => Number(a.label.startsWith('Anywhere')) - Number(b.label.startsWith('Anywhere')));
}

export function phoneStatus() {
  if (!phoneEnabled()) return { enabled: false as const };
  const code = phoneCode();
  const urls = addresses();
  // The code rides in the URL fragment, which never leaves the phone's browser in a request.
  const pair = urls[0] && `${urls[0].url}/#/pair/${code}`;
  return { enabled: true as const, code, urls, listening: !!server?.listening, qr: pair ? renderSVG(pair, { border: 1 }) : null };
}

/** Opens the phone port; resolves once it is listening, or has failed (port taken). */
function start(): Promise<void> {
  if (server?.listening || !fetcher) return Promise.resolve();
  const f = fetcher;
  const s = serve({ fetch: (req, env) => f(req, { ...(env as object), phone: true }), hostname: '0.0.0.0', port: PHONE_PORT }) as Server;
  server = s;
  return new Promise((resolve) => {
    s.once('listening', () => resolve());
    s.once('error', (e) => {
      console.warn('[phone] could not listen:', e.message);
      if (server === s) server = null;
      resolve();
    });
  });
}

function stop() {
  server?.closeAllConnections();
  server?.close();
  server = null;
}

/** Called once at startup with the app's fetch handler. */
export function initPhone(fetch: Fetch) {
  fetcher = fetch;
  if (phoneEnabled()) void start();
}

/** Turn phone access on or off. A new code signs every paired phone out. */
export async function setPhone(enabled: boolean, newPairing = false) {
  if (enabled && (newPairing || !phoneCode())) setKV('phone.code', seal(newCode()));
  setKV('phone.enabled', enabled ? '1' : '');
  if (enabled) await start();
  else stop();
  return phoneStatus();
}
