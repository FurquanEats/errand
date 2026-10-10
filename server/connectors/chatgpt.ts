import crypto from 'node:crypto';
import { get, run } from '../db.ts';
import { seal, unseal } from '../crypto.ts';
import { getKV, setKV } from '../settings.ts';
import { PORT } from '../config.ts';

/**
 * "Continue with ChatGPT": use a ChatGPT plan (Go, Plus, Pro) instead of an API key.
 *
 * Implements OpenAI's official Sign in with ChatGPT flow for open-source, locally hosted apps
 * (https://developers.openai.com/siwc/token-sharing-open-source): OAuth 2.0 + PKCE with dynamic
 * client registration and a loopback redirect, then the public Responses API with
 * store=false and stream=true. Usage counts toward the user's ChatGPT plan limits.
 */

const AUTH = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

// The redirect must be an http loopback on 127.0.0.1 with path /callback ("localhost" is rejected).
export const CALLBACK_PATH = '/callback';
const redirectUri = () => `http://127.0.0.1:${PORT}${CALLBACK_PATH}`;

/** Stable per-install agent host id (urn:uuid form). Not a credential. */
function hostId() {
  let h = getKV('chatgpt.hostId');
  if (!h) {
    h = `urn:uuid:${crypto.randomUUID()}`;
    setKV('chatgpt.hostId', h);
  }
  return h;
}

interface Pending {
  verifier: string;
  nonce: string;
  clientId: string;
  at: number;
}
const pending = new Map<string, Pending>();

export interface ChatGPTCredentials {
  clientId: string;
  sub: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function startSignIn(): string {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  // Reuse the client issued on a previous sign-in; otherwise register a new one.
  const issued = getKV('chatgpt.clientId');
  const clientId = issued || 'dynamic_agent_client';
  pending.set(state, { verifier, nonce, clientId, at: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId,
    ext_agent_host_id: hostId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  if (!issued) params.set('agent_name_hint', 'Errand');
  return `${AUTHORIZE_URL}?${params}`;
}

export async function finishSignIn(query: Record<string, string | undefined>): Promise<ChatGPTCredentials> {
  const p = query.state ? pending.get(query.state) : undefined;
  if (query.state) pending.delete(query.state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('This sign-in was not started here or has expired. Try again.');
  if (query.error) throw new Error(query.error === 'access_denied' ? 'Sign-in was cancelled.' : `ChatGPT sign-in failed: ${query.error}`);
  if (!query.code) throw new Error('No authorization code returned.');

  const clientId = query.client_id || p.clientId;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: query.code,
      code_verifier: p.verifier,
      redirect_uri: redirectUri(),
      resource: RESOURCE,
    }),
  });
  const tok: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ChatGPT token exchange failed: ${tok.error_description ?? tok.error ?? res.status}`);
  const issuedClientId: string = tok.client_id || clientId;
  if (
    !String(tok.scope ?? '')
      .split(' ')
      .includes('chatgpt.tokens.use.direct')
  )
    throw new Error('ChatGPT did not grant plan usage for this app.');

  const claims = await verifyIdToken(tok.id_token, issuedClientId, p.nonce);
  setKV('chatgpt.clientId', issuedClientId);
  return {
    clientId: issuedClientId,
    sub: claims.sub,
    email: claims.email ?? '',
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    idToken: tok.id_token,
    expiresAt: Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000,
  };
}

// ── ID token validation (RS256 against OpenAI's published JWKS) ─────────────
let jwksCache: { at: number; keys: any[] } | null = null;
async function jwks() {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const discovery: any = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json();
  const { keys } = (await (await fetch(discovery.jwks_uri)).json()) as { keys: any[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}

async function verifyIdToken(idToken: string, clientId: string, nonce: string) {
  const [h, pl, sig] = String(idToken ?? '').split('.');
  if (!sig) throw new Error('Missing ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(pl, 'base64url').toString());
  const jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') throw new Error('ID token signed with an unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${pl}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ok) throw new Error('ID token signature is invalid');
  if (claims.iss !== AUTH) throw new Error('ID token issuer mismatch');
  if (!aud.includes(clientId)) throw new Error('ID token audience mismatch');
  if (claims.exp * 1000 < Date.now()) throw new Error('ID token expired');
  if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  return claims as { sub: string; email?: string };
}

// ── Tokens for inference ─────────────────────────────────────────────────────
function load(providerId: string): ChatGPTCredentials {
  const row = get<{ api_key: string }>('SELECT api_key FROM providers WHERE id = ?', providerId);
  if (!row?.api_key) throw new Error('ChatGPT sign-in missing. Continue with ChatGPT again in Settings → Models.');
  return JSON.parse(unseal(row.api_key));
}

export function saveCredentials(providerId: string, creds: ChatGPTCredentials) {
  run('UPDATE providers SET api_key = ? WHERE id = ?', seal(JSON.stringify(creds)), providerId);
}

const refreshing = new Map<string, Promise<string>>();

async function accessTokenFor(providerId: string): Promise<string> {
  const creds = load(providerId);
  if (creds.expiresAt > Date.now()) return creds.accessToken;
  if (!refreshing.has(providerId)) {
    refreshing.set(
      providerId,
      (async () => {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: creds.clientId, refresh_token: creds.refreshToken, resource: RESOURCE }),
        });
        const tok: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Your ChatGPT session expired (${tok.error ?? res.status}). Continue with ChatGPT again in Settings → Models.`);
        saveCredentials(providerId, {
          ...creds,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token ?? creds.refreshToken,
          idToken: tok.id_token ?? creds.idToken,
          expiresAt: Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000,
        });
        return tok.access_token as string;
      })().finally(() => refreshing.delete(providerId)),
    );
  }
  return refreshing.get(providerId)!;
}

/** Models this ChatGPT account may use (catalog entries with visibility "list"). */
export async function listModels(accessToken: string): Promise<string[]> {
  const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not load ChatGPT models: ${body.error?.message ?? res.status}`);
  // The catalog's own order of preference (lower priority first), so the first entry is the best default.
  return (body.models ?? body.data ?? [])
    .filter((m: any) => (m.visibility ?? 'list') === 'list')
    .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m: any) => String(m.slug ?? m.id));
}

export async function refreshModelList(providerId: string) {
  return listModels(await accessTokenFor(providerId));
}

/**
 * fetch() for the OpenAI provider when signed in with ChatGPT. It injects a fresh token and
 * applies the flow's rules: Responses API only, store=false, stream=true. Non-streaming calls
 * are served by reading the stream and returning the final `response.completed` payload.
 */
export function chatgptFetch(providerId: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(`${RESOURCE}/responses`)) throw new Error('Only the Responses API is available when signed in with ChatGPT.');
    const body = JSON.parse(String(init?.body ?? '{}'));
    const wantsStream = body.stream === true;
    body.stream = true;
    body.store = false;
    // Without storage there is nothing to reference by id; drop item references from history.
    if (Array.isArray(body.input)) body.input = body.input.filter((item: any) => item?.type !== 'item_reference');
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${await accessTokenFor(providerId)}`);
    const res = await fetch(url, { ...init, headers, body: JSON.stringify(body) });
    if (wantsStream || !res.ok || !res.body) return res;

    const text = await res.text();
    let final: any = null;
    const items: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'response.output_item.done' && ev.item) items.push(ev.item);
        if (ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.incomplete') final = ev;
      } catch {
        /* keep-alive or [DONE] */
      }
    }
    if (final?.type === 'response.completed' || final?.type === 'response.incomplete') {
      // Some plans stream the output items but leave the final payload's output empty.
      if (!final.response.output?.length) final.response.output = items;
      return new Response(JSON.stringify(final.response), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const error = final?.response?.error ?? { message: 'ChatGPT returned no completed response', code: 'incomplete_stream' };
    return new Response(JSON.stringify({ error }), {
      status: error.code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502,
      headers: { 'content-type': 'application/json' },
    });
  };
}
