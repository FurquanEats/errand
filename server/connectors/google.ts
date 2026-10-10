import crypto from 'node:crypto';
import { getSettings } from '../settings.ts';
import { unseal } from '../crypto.ts';
import { PORT } from '../config.ts';

/**
 * "Connect Google": Gmail, Calendar and Drive for any number of Google accounts.
 *
 * Bring-your-own OAuth client, in the same spirit as bring-your-own model key: create a free
 * OAuth client in Google Cloud Console (type "Web application"), add the redirect URI shown in
 * Settings, and paste the client id + secret. Tokens never leave your server.
 */

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://mail.google.com/', // IMAP/SMTP via XOAUTH2
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.settings.basic', // create filters so new mail is labeled automatically
];

export const publicUrl = () => (process.env.ERRAND_PUBLIC_URL || getSettings().publicUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const redirectUri = () => `${publicUrl()}/api/oauth/google/callback`;

function client() {
  const g = getSettings().google;
  const secret = unseal(g.clientSecret);
  if (!g.clientId || !secret) throw new Error('Google is not set up. Add your OAuth client in Settings → Accounts → Connections.');
  return { id: g.clientId, secret };
}

export const googleConfigured = () => !!getSettings().google.clientId && !!getSettings().google.clientSecret;

const states = new Map<string, number>();

export function authUrl(loginHint?: string): string {
  const { id } = client();
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account', // always returns a refresh token and lets you pick another account
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange the callback code. Returns the account's email and refresh token. */
export async function handleCallback(code: string, state: string) {
  const issued = states.get(state);
  states.delete(state);
  if (!issued || Date.now() - issued > 10 * 60_000) throw new Error('Sign-in expired or was not started here. Try again.');
  const { id, secret } = client();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const tok: any = await res.json();
  if (!res.ok || !tok.refresh_token) throw new Error(`Google sign-in failed: ${tok.error_description ?? tok.error ?? 'no refresh token returned'}`);
  const info: any = await (
    await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })
  ).json();
  cache.set(info.email, { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
  return { email: String(info.email), name: String(info.name ?? ''), refreshToken: String(tok.refresh_token) };
}

const cache = new Map<string, { token: string; expires: number }>();

export async function accessToken(email: string, refreshToken: string): Promise<string> {
  const hit = cache.get(email);
  if (hit && hit.expires > Date.now()) return hit.token;
  const { id, secret } = client();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: id, client_secret: secret, grant_type: 'refresh_token' }),
  });
  const tok: any = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed for ${email}: ${tok.error_description ?? tok.error}. Reconnect the account.`);
  cache.set(email, { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
  return tok.access_token;
}

async function gapi(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body: any = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${body.error?.message ?? res.statusText}`);
  return body;
}

// ── Calendar ─────────────────────────────────────────────────────────────────
export async function calendarEvents(token: string, from: Date, to: Date) {
  const { items: calendars = [] } = await gapi(token, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  const out: { calendar: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string }[] = [];
  for (const cal of calendars.filter((c: any) => c.selected !== false).slice(0, 15)) {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });
    const { items = [] } = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`).catch(() => ({
      items: [],
    }));
    for (const e of items) {
      out.push({
        calendar: cal.summaryOverride ?? cal.summary,
        title: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        allDay: !!e.start?.date,
        location: e.location ?? '',
        description: (e.description ?? '').slice(0, 500),
      });
    }
  }
  return out;
}

export async function createCalendarEvent(
  token: string,
  e: { title: string; start: string; end: string; location?: string; description?: string; attendees?: string[] },
) {
  const body = {
    summary: e.title,
    location: e.location,
    description: e.description,
    start: { dateTime: new Date(e.start).toISOString() },
    end: { dateTime: new Date(e.end).toISOString() },
    attendees: e.attendees?.map((email) => ({ email })),
  };
  const created = await gapi(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
  return { id: created.id, link: created.htmlLink };
}

// ── Drive ────────────────────────────────────────────────────────────────────
export async function driveSearch(token: string, query: string) {
  const q = `fullText contains '${query.replace(/['\\]/g, '\\$&')}' and trashed = false`;
  const params = new URLSearchParams({ q, pageSize: '15', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' });
  const { files = [] } = await gapi(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  return files;
}

/** Create a Gmail filter: label (and optionally skip the inbox) for matching mail. */
export async function createGmailFilter(token: string, opts: { from?: string; query?: string; label: string; skipInbox?: boolean }) {
  const { labels = [] } = await gapi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
  let label = labels.find((l: any) => l.name.toLowerCase() === opts.label.toLowerCase());
  if (!label)
    label = await gapi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/labels', { method: 'POST', body: JSON.stringify({ name: opts.label }) });
  const filter = await gapi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/settings/filters', {
    method: 'POST',
    body: JSON.stringify({
      criteria: { from: opts.from, query: opts.query },
      action: { addLabelIds: [label.id], removeLabelIds: opts.skipInbox ? ['INBOX'] : [] },
    }),
  });
  return { filterId: filter.id, label: label.name };
}

export async function driveRecent(token: string) {
  const params = new URLSearchParams({ pageSize: '25', orderBy: 'modifiedTime desc', q: 'trashed = false', fields: 'files(id,name,mimeType,modifiedTime)' });
  const { files = [] } = await gapi(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  return files;
}

export async function driveRead(token: string, fileId: string) {
  const meta = await gapi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`);
  const exportAs: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };
  const url = exportAs[meta.mimeType]
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType])}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
  let text: string;
  if (meta.mimeType === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
    text = (await extractText(pdf, { mergePages: true })).text as string;
  } else text = await res.text();
  return { name: meta.name, mimeType: meta.mimeType, text: text.slice(0, 40000) };
}
