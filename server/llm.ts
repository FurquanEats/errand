import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import type { z } from 'zod';
import { all, get, id, insert, now, parseJSON, patch, run } from './db.ts';
import { seal, unseal } from './crypto.ts';
import { chatgptFetch, refreshModelList, saveCredentials, type ChatGPTCredentials } from './connectors/chatgpt.ts';
import { getSettings, saveSettings } from './settings.ts';

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'chatgpt';

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string | null;
  api_key: string | null;
  models: string;
  created_at: number;
}

/** Presets shown in Settings. Anything that speaks the OpenAI API works via "custom". */
export const PROVIDER_PRESETS = [
  { preset: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: '', needsKey: true },
  { preset: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: '', needsKey: true },
  { preset: 'google', kind: 'google', name: 'Google Gemini', baseUrl: '', needsKey: true },
  { preset: 'openrouter', kind: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { preset: 'groq', kind: 'openai-compatible', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { preset: 'mistral', kind: 'openai-compatible', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { preset: 'deepseek', kind: 'openai-compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { preset: 'xai', kind: 'openai-compatible', name: 'xAI', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { preset: 'together', kind: 'openai-compatible', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', needsKey: true },
  { preset: 'ollama', kind: 'openai-compatible', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { preset: 'lmstudio', kind: 'openai-compatible', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { preset: 'custom', kind: 'openai-compatible', name: 'Custom (OpenAI-compatible)', baseUrl: '', needsKey: false },
] as const;

export function listProviders() {
  return all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map((p) => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseUrl: p.base_url ?? '',
    hasKey: !!p.api_key,
    account: p.kind === 'chatgpt' ? chatgptAccount(p.api_key) : undefined,
    models: parseJSON<string[]>(p.models, []),
  }));
}

export function addProvider(input: { kind: ProviderKind; name: string; baseUrl?: string; apiKey?: string; models?: string[] }) {
  const pid = id();
  insert('providers', {
    id: pid,
    kind: input.kind,
    name: input.name,
    base_url: input.baseUrl || null,
    api_key: input.apiKey ? seal(input.apiKey) : null,
    models: JSON.stringify(input.models ?? []),
    created_at: now(),
  });
  return pid;
}

export function updateProvider(pid: string, input: { name?: string; baseUrl?: string; apiKey?: string; models?: string[] }) {
  patch(
    'providers',
    pid,
    {
      name: input.name,
      base_url: input.baseUrl,
      api_key: input.apiKey ? seal(input.apiKey) : undefined,
      models: input.models ? JSON.stringify(input.models) : undefined,
    },
    ['name', 'base_url', 'api_key', 'models'],
  );
}

export const deleteProvider = (pid: string) => run('DELETE FROM providers WHERE id = ?', pid);

function chatgptAccount(sealed: string | null) {
  try {
    return (JSON.parse(unseal(sealed)) as ChatGPTCredentials).email;
  } catch {
    return '';
  }
}

/** Create or update the ChatGPT-plan provider after "Continue with ChatGPT". */
export async function upsertChatGPTProvider(creds: ChatGPTCredentials): Promise<string> {
  const existing = all<ProviderRow>("SELECT * FROM providers WHERE kind = 'chatgpt'").find((p) => {
    try {
      return (JSON.parse(unseal(p.api_key)) as ChatGPTCredentials).sub === creds.sub;
    } catch {
      return false;
    }
  });
  const pid = existing?.id ?? addProvider({ kind: 'chatgpt', name: 'ChatGPT', models: [] });
  saveCredentials(pid, creds);
  const models = await refreshModelList(pid).catch(() => [] as string[]);
  if (models.length) updateProvider(pid, { models });
  const s = getSettings();
  if (!s.models.chat && models[0]) saveSettings({ models: { ...s.models, chat: `${pid}:${models[0]}` } });
  return pid;
}

function providerFor(row: ProviderRow) {
  const apiKey = unseal(row.api_key) || undefined;
  const baseURL = row.base_url || undefined;
  switch (row.kind) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL });
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL });
    case 'google':
      return createGoogle({ apiKey, baseURL });
    case 'chatgpt':
      // Plan usage via Sign in with ChatGPT: Responses API with the user's OAuth token.
      return createOpenAI({ apiKey: 'chatgpt-plan', fetch: chatgptFetch(row.id) });
    default:
      return createOpenAICompatible({ name: row.name.toLowerCase().replace(/\W+/g, '-'), baseURL: baseURL ?? '', apiKey });
  }
}

export class NoModelError extends Error {
  constructor(role: string) {
    super(`No ${role} model configured. Open Settings → Models and add a provider with your API key.`);
  }
}

/** Resolve a "providerId:modelId" reference into a model instance. */
export function resolveModel(ref: string): LanguageModel {
  const idx = ref.indexOf(':');
  if (idx < 0) throw new Error(`Bad model reference "${ref}"`);
  const row = get<ProviderRow>('SELECT * FROM providers WHERE id = ?', ref.slice(0, idx));
  if (!row) throw new Error(`Provider for "${ref}" no longer exists`);
  return providerFor(row).languageModel(ref.slice(idx + 1));
}

export type ModelRole = 'chat' | 'handoff' | 'utility';
/** Told when another model had to answer because the configured one failed. */
export type FallbackNotice = (from: string, to: string, error: unknown) => void;

/**
 * chat → main model; handoff → browser agent; utility → background jobs. Falls back to chat.
 * If the model fails (busy, rate-limited, key revoked, server down), the best model from each
 * other connected provider is tried in turn, so a single outage never stops Errand.
 */
export function getModel(role: ModelRole, onFallback?: FallbackNotice): LanguageModel {
  const { models } = getSettings();
  const ref = models[role] || models.chat || firstAvailableModel();
  if (!ref) throw new NoModelError(role);
  const refs = fallbackRefs(ref, role);
  return refs.length > 1 ? withFallback(ref, refs, onFallback) : resolveModel(ref);
}

/** "Google Gemini · gemini-3-pro" for a "providerId:model" reference. */
export function modelLabel(ref: string) {
  const idx = ref.indexOf(':');
  const p = get<ProviderRow>('SELECT name FROM providers WHERE id = ?', ref.slice(0, idx));
  return p ? `${p.name} · ${ref.slice(idx + 1)}` : ref.slice(idx + 1);
}

// Models that just failed are tried last for a few minutes, so an outage doesn't slow every reply.
const cooling = new Map<string, number>();
const COOL_MS = 5 * 60_000;

export function fallbackRefs(primary: string, role: ModelRole): string[] {
  const pid = primary.slice(0, primary.indexOf(':'));
  const pick = (models: string[]) => {
    const p = pickBestModels(models);
    return p && (role === 'utility' ? p.fast : p.best);
  };
  const providers = listProviders();
  const others = providers
    .filter((p) => p.id !== pid)
    .map((p) => {
      const m = pick(p.models);
      return m && `${p.id}:${m}`;
    });
  const own = providers.find((p) => p.id === pid);
  const sibling = own && pick(own.models.filter((m) => `${pid}:${m}` !== primary));
  const refs = [...new Set([primary, ...others, sibling && `${pid}:${sibling}`].filter((r): r is string => !!r))];
  const cold = (r: string) => Number((cooling.get(r) ?? 0) > Date.now());
  return refs.sort((a, b) => cold(a) - cold(b)).slice(0, 3);
}

function withFallback(primary: string, refs: string[], onFallback?: FallbackNotice): LanguageModelV4 {
  const head = (() => {
    try {
      return resolveModel(refs[0]) as LanguageModelV4;
    } catch {
      return undefined;
    }
  })();
  async function attempt<T>(call: (m: LanguageModelV4) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastErr: unknown;
    for (const ref of refs) {
      try {
        const result = await call(ref === refs[0] && head ? head : (resolveModel(ref) as LanguageModelV4));
        cooling.delete(ref);
        if (ref !== primary) {
          console.warn(`[model] ${modelLabel(primary)} failed, used ${modelLabel(ref)}:`, String((lastErr as Error)?.message ?? lastErr ?? 'cooling down'));
          onFallback?.(primary, ref, lastErr);
        }
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        // A 400 is usually about this request (too long, bad input), not the model being down, so it
        // doesn't send the model to the back of the queue. Some providers (Gemini) send bad keys as 400 too.
        const e = err as { statusCode?: number; message?: string };
        if (e?.statusCode !== 400 || /api.?key|credential|permission/i.test(String(e?.message))) cooling.set(ref, Date.now() + COOL_MS);
        lastErr = err;
      }
    }
    throw lastErr;
  }
  return {
    specificationVersion: 'v4',
    provider: head?.provider ?? 'errand',
    modelId: head?.modelId ?? primary,
    supportedUrls: head?.supportedUrls ?? {},
    doGenerate: (o) => attempt((m) => Promise.resolve(m.doGenerate(o)), o.abortSignal),
    doStream: (o) => attempt(async (m) => openedStream(await m.doStream(o)), o.abortSignal),
  };
}

/** Waits for the first real output so an error the provider streams before any content still falls back. */
async function openedStream(result: LanguageModelV4StreamResult): Promise<LanguageModelV4StreamResult> {
  const reader = result.stream.getReader();
  const buffered: LanguageModelV4StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'error') {
      reader.cancel().catch(() => {});
      throw value.error;
    }
    buffered.push(value);
    if (!['stream-start', 'response-metadata', 'raw'].includes(value.type)) break;
  }
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start: (c) => buffered.forEach((p) => c.enqueue(p)),
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { ...result, stream };
}

function firstAvailableModel(): string {
  for (const p of listProviders()) if (p.models[0]) return `${p.id}:${p.models[0]}`;
  return '';
}

export function hasModel() {
  try {
    getModel('chat');
    return true;
  } catch {
    return false;
  }
}

/** Ask the provider which models it offers. Best effort: not every endpoint supports listing. */
export async function fetchModelList(input: { kind: ProviderKind; baseUrl?: string; apiKey?: string; providerId?: string }): Promise<string[]> {
  if (input.kind === 'chatgpt' && input.providerId) return refreshModelList(input.providerId);
  let apiKey = input.apiKey ?? '';
  let baseUrl = input.baseUrl ?? '';
  if (input.providerId) {
    const row = get<ProviderRow>('SELECT * FROM providers WHERE id = ?', input.providerId);
    if (row) {
      apiKey ||= unseal(row.api_key);
      baseUrl ||= row.base_url ?? '';
    }
  }
  const trim = (u: string) => u.replace(/\/+$/, '');
  let url: string;
  const headers: Record<string, string> = {};
  if (input.kind === 'anthropic') {
    url = `${trim(baseUrl || 'https://api.anthropic.com/v1')}/models?limit=1000`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (input.kind === 'google') {
    url = `${trim(baseUrl || 'https://generativelanguage.googleapis.com/v1beta')}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
  } else {
    url = `${trim(baseUrl || 'https://api.openai.com/v1')}/models`;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const list: any[] = body.data ?? body.models ?? [];
  return list
    .map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}

/**
 * Get structured JSON out of any model, including ones without native structured-output
 * support (most local models). Asks for JSON, extracts it, validates, retries once with the error.
 */
export async function generateJSON<T>(opts: {
  role?: 'chat' | 'handoff' | 'utility';
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  example?: string;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const model = getModel(opts.role ?? 'utility');
  const system = `${opts.system ?? ''}\n\nRespond with a single valid JSON value only. No prose, no markdown fences.${
    opts.example ? `\nShape example:\n${opts.example}` : ''
  }`.trim();
  let prompt = opts.prompt;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await generateText({ model, system, prompt, abortSignal: opts.abortSignal });
    try {
      return opts.schema.parse(extractJSON(text));
    } catch (err) {
      lastErr = err;
      prompt = `${opts.prompt}\n\nYour previous answer was invalid (${String(err).slice(0, 300)}). Return corrected JSON only.`;
    }
  }
  throw lastErr;
}

export function extractJSON(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    if (start < 0) throw new Error('No JSON found in model output');
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    const end = cleaned.lastIndexOf(close);
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

// ── Automatic model choice ───────────────────────────────────────────────────
const NOT_CHAT =
  /embed|tts|whisper|audio|realtime|transcri|image|dall-e|moderation|search|computer-use|deep-research|(^|\/)aqa|imagen|veo|lyria|robotics|guard|rerank|ocr|-instruct|babbage|davinci|antigravity|live|learnlm|gemma|codex|review/i;
const FAST = /\b(mini|flash|haiku|lite|nano|small|tiny|fast|instant|luna)\b|\b[1-9]b\b/i;
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{8}$|-\d{2}-\d{4}$|preview|-exp|beta/i;

/** Family version in a model id ("gemini-3.8-pro" → 3.8, "llama-3.3-70b" → 3.3); dates are ignored. */
function modelVersion(model: string) {
  for (const m of model.matchAll(/(\d+)(?:[.-](\d{1,2})(?!\d))?(?![\db])/g)) {
    const major = Number(m[1]);
    if (major > 0 && major <= 20) return major + (m[2] ? Number(m[2]) / 100 : 0);
  }
  return 0;
}
const modelScore = (model: string) =>
  modelVersion(model) * 100 +
  (/opus|pro\b|ultra|large|max/i.test(model) ? 10 : 0) +
  (SNAPSHOT.test(model) ? -40 : 0) +
  (/latest$/.test(model) ? 5 : 0) -
  model.length / 100;

/**
 * Picks the strongest general chat model and a fast one for background jobs from a provider's
 * model list: newest family version first, flagship tiers over small ones, stable over previews.
 */
export function pickBestModels(models: string[]): { best: string; fast: string } | null {
  const chat = models.filter((m) => !NOT_CHAT.test(m));
  const pool = chat.length ? chat : models;
  if (!pool.length) return null;
  const top = (list: string[]) => [...list].sort((a, b) => modelScore(b) - modelScore(a))[0];
  const strong = pool.filter((m) => !FAST.test(m));
  const quick = pool.filter((m) => FAST.test(m));
  const best = top(strong.length ? strong : pool);
  return { best, fast: quick.length ? top(quick) : best };
}

/** Fill in model lists for ChatGPT sign-ins saved before their catalog could be read. */
export async function repairChatGPTModels() {
  for (const p of all<ProviderRow>("SELECT * FROM providers WHERE kind = 'chatgpt'")) {
    if (parseJSON<string[]>(p.models, []).length) continue;
    const models = await refreshModelList(p.id).catch(() => [] as string[]);
    if (!models.length) continue;
    updateProvider(p.id, { models });
    const s = getSettings();
    if (!s.models.chat) saveSettings({ models: { ...s.models, chat: `${p.id}:${models[0]}` } });
  }
}
