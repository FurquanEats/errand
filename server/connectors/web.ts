import { getSettings } from '../settings.ts';
import { unseal } from '../crypto.ts';
import { safeFetch } from '../security.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));

export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function webSearch(query: string, count = 8): Promise<SearchResult[]> {
  const s = getSettings().search;
  const apiKey = unseal(s.apiKey);
  if (s.provider === 'google' && apiKey) {
    // Google results through Serper.dev (Google has no open search API for new users).
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num: count }),
    });
    const body: any = await res.json();
    return (body.organic ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }));
  }
  if (s.provider === 'brave' && apiKey) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
    });
    const body: any = await res.json();
    return (body.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description ?? '') }));
  }
  if (s.provider === 'tavily' && apiKey) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: count }),
    });
    const body: any = await res.json();
    return (body.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
  }
  if (s.provider === 'searxng' && s.url) {
    const res = await fetch(`${s.url.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`);
    const body: any = await res.json();
    return (body.results ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
  // Default: DuckDuckGo's HTML endpoint, which needs no key.
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
  });
  const html = await res.text();
  const results: SearchResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < count) {
    let url = decode(m[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3]) });
  }
  if (!results.length && /anomaly|captcha/i.test(html)) {
    // DuckDuckGo limits bursts of searches. Wikipedia's free search still answers most factual questions.
    const wiki = await wikipediaSearch(query, count).catch(() => []);
    if (wiki.length) return wiki;
    throw new Error('Web search is busy right now (DuckDuckGo limits bursts). Try again in a minute, or add a search key in Settings → Search.');
  }
  return results;
}

async function wikipediaSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${count}&srsearch=${encodeURIComponent(query)}`;
  const body: any = await (await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })).json();
  return (body.query?.search ?? []).map((r: any) => ({
    title: `${r.title} (Wikipedia)`,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: htmlToText(r.snippet ?? ''),
  }));
}

export async function fetchPage(url: string, maxChars = 20000): Promise<{ url: string; title: string; text: string; json?: unknown }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
  // Model-chosen URLs may come from untrusted content, so private/local addresses are refused.
  const res = await safeFetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') ?? '';
  const body = await res.text();
  if (type.includes('json')) {
    return { url: res.url || url, title: '', text: body.slice(0, maxChars), json: safeJSON(body) };
  }
  const title = htmlToText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const main = body.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] ?? body;
  return { url: res.url || url, title, text: htmlToText(main).slice(0, maxChars) };
}

function safeJSON(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
