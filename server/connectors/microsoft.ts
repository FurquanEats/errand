import crypto from 'node:crypto';
import { getSettings } from '../settings.ts';
import { PORT } from '../config.ts';

/**
 * "Continue with Microsoft": Outlook.com, Hotmail, Live and Microsoft 365 mail over IMAP/SMTP with
 * OAuth (Microsoft no longer allows app passwords for these). A public client with PKCE, so there is
 * no secret: the client id is the one built into Errand, or your own app registration's from
 * Settings (type "Mobile and desktop", redirect http://localhost, personal + work accounts).
 */

// Filled in once Errand's own Microsoft app registration exists; until then, bring your own.
const BUILT_IN_CLIENT_ID = '';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = ['openid', 'email', 'profile', 'offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'];

export const microsoftClientId = () => getSettings().microsoft.clientId || BUILT_IN_CLIENT_ID;
export const microsoftConfigured = () => !!microsoftClientId();
// Microsoft lets desktop apps use any port on http://localhost, so this works on every install.
export const microsoftRedirectUri = () => `http://localhost:${PORT}/api/oauth/microsoft/callback`;

export const OUTLOOK = {
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp-mail.outlook.com',
  smtpPort: 587,
  smtpSecure: false,
};

const pending = new Map<string, { verifier: string; at: number }>();

export function microsoftAuthUrl(loginHint?: string) {
  const id = microsoftClientId();
  if (!id) throw new Error('Microsoft sign-in is not set up yet. Add a client id in Settings → Accounts.');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  pending.set(state, { verifier, at: Date.now() });
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: microsoftRedirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTHORITY}/authorize?${params}`;
}

async function token(body: Record<string, string>) {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: microsoftClientId(), scope: SCOPES.join(' '), ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const tok: any = await res.json();
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${tok.error_description?.split('\r\n')[0] ?? tok.error ?? res.statusText}`);
  return tok as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

/** Exchange the callback code. Returns the mailbox address, name and refresh token. */
export async function microsoftCallback(code: string, state: string) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('Sign-in expired or was not started here. Try again.');
  const tok = await token({ grant_type: 'authorization_code', code, redirect_uri: microsoftRedirectUri(), code_verifier: p.verifier });
  // The ID token comes straight from Microsoft over TLS, so its claims can be read as they are.
  const claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1] ?? '', 'base64url').toString() || '{}');
  const address = String(claims.email ?? claims.preferred_username ?? '');
  if (!address.includes('@') || !tok.refresh_token) throw new Error('Microsoft did not return a mailbox for this account.');
  cache.set(address.toLowerCase(), { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
  return { address, name: String(claims.name ?? ''), refreshToken: tok.refresh_token };
}

const cache = new Map<string, { token: string; expires: number }>();

/** A fresh access token. Microsoft rotates refresh tokens, so a new one is handed to `save`. */
export async function microsoftAccessToken(address: string, refreshToken: string, save: (next: string) => void) {
  const hit = cache.get(address.toLowerCase());
  if (hit && hit.expires > Date.now()) return hit.token;
  const tok = await token({ grant_type: 'refresh_token', refresh_token: refreshToken }).catch((e) => {
    throw new Error(`${(e as Error).message}. Reconnect ${address} in Settings → Accounts.`);
  });
  if (tok.refresh_token && tok.refresh_token !== refreshToken) save(tok.refresh_token);
  cache.set(address.toLowerCase(), { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
  return tok.access_token;
}
