import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    // X-Errand marks requests as coming from this app; the server rejects writes without it (CSRF defence).
    headers: { 'x-errand': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  }).catch(() => {
    throw new ApiError('Can’t reach Errand. Check that it’s still running on your computer, then try again.', 0);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.needsLogin) window.dispatchEvent(new CustomEvent('errand:login', { detail: { phone: !!data.phone } }));
    throw new ApiError(data?.error ?? res.statusText, res.status);
  }
  return data as T;
}

// One shared EventSource for the whole app.
export type ServerEvent = { type: string; [k: string]: any };
type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data) as ServerEvent;
      listeners.forEach((l) => l(e));
    } catch {
      /* ignore */
    }
  };
  source.onerror = () => {
    // Browser reconnects automatically; tell views to resync once it does.
    listeners.forEach((l) => l({ type: 'disconnected' }));
    source!.onopen = () => listeners.forEach((l) => l({ type: 'reconnected' }));
  };
}

export function useEvents(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureSource();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Fetch a resource and refetch whenever one of the given event types arrives. */
export function useResource<T>(path: string | null, refreshOn: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    setData(null);
    void reload();
  }, [reload]);
  useEvents((e) => {
    if (e.type === 'reconnected' || refreshOn.includes(e.type)) void reload();
  });
  return { data, error, loading, reload, setData };
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fileToAttachment(file: File): Promise<{ name: string; mediaType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, mediaType: file.type || 'application/octet-stream', data: String(r.result).split(',')[1] ?? '' });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** A message to pre-fill in the chat composer (e.g. "Ask" on a Home card). */
export function setDraft(text: string) {
  try {
    sessionStorage.setItem('errand.draft', text);
  } catch {
    /* storage unavailable */
  }
}

export function takeDraft(): string {
  try {
    const d = sessionStorage.getItem('errand.draft') ?? '';
    sessionStorage.removeItem('errand.draft');
    return d;
  } catch {
    return '';
  }
}
