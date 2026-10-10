import crypto from 'node:crypto';

/**
 * "Continue with OpenRouter": OpenRouter's official OAuth PKCE flow mints an API key on the
 * user's own OpenRouter account (one sign-in, hundreds of models, the user's own credits).
 * https://openrouter.ai/docs/guides/overview/auth/oauth
 */

const pending = new Map<string, { verifier: string; at: number }>();

export function startOpenRouter(origin: string): string {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { verifier, at: Date.now() });
  const callback = `${origin}/api/oauth/openrouter/callback?state=${state}`;
  const params = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'Errand' });
  return `https://openrouter.ai/auth?${params}`;
}

export async function finishOpenRouter(code: string, state: string): Promise<string> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('This sign-in was not started here or has expired. Try again.');
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.key) throw new Error(`OpenRouter sign-in failed: ${body.error?.message ?? res.status}`);
  return String(body.key);
}
