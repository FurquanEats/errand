import { tool } from 'ai';
import { z } from 'zod';
import { fetchPage, webSearch } from '../connectors/web.ts';
import { apiKeyFor, listItems } from '../vault.ts';
import { isUnder, safeFetch } from '../security.ts';
import { requestApproval } from '../approvals.ts';
import { forecast } from '../weather.ts';
import type { ToolContext } from './index.ts';

export const webTools = (ctx: ToolContext = {}) => ({
  web_search: tool({
    description: 'Search the web for current information.',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => webSearch(query),
  }),
  weather_forecast: tool({
    description: 'Daily weather forecast (up to 16 days) for the user’s location or any place. Use this for weather, not web_search.',
    inputSchema: z.object({ place: z.string().optional().describe('omit for the user’s own location'), days: z.number().int().min(1).max(16).default(7) }),
    execute: async ({ place, days }) => forecast(place, days),
  }),
  fetch_url: tool({
    description: 'Read a public web page or JSON API (GET). Fast; prefer this over handoff for read-only lookups.',
    inputSchema: z.object({ url: z.string() }),
    execute: async ({ url }) => fetchPage(url),
  }),
  api_request: tool({
    description:
      `Call a web API using an API key saved in the vault (${
        listItems()
          .filter((i) => i.kind === 'api_key')
          .map((i) => i.label)
          .join(', ') || 'none saved yet'
      }). ` +
      'The key is attached for you and never shown. Requests other than GET ask the user first. If the service has no saved key, use connect_account(service: "api_key").',
    inputSchema: z.object({
      service: z.string().describe('label of the saved key'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      url: z.string(),
      body: z.any().optional(),
    }),
    execute: async ({ service, method, url, body }) => {
      const cred = apiKeyFor(service);
      if (!cred) return { error: `No API key saved for "${service}". Ask the user to add it in Settings → Accounts → API Keys.` };
      // A key is only ever sent to the base URL it was saved for, so injected instructions can't exfiltrate it.
      if (!cred.baseUrl) return { error: `The ${cred.label} key has no base URL. Add one in Settings → Accounts → API Keys.` };
      if (!isUnder(url, cred.baseUrl)) return { error: `The ${cred.label} key may only be sent to ${cred.baseUrl}` };
      if (method !== 'GET' && ctx.readOnly) return { error: 'Only GET requests are allowed here' };
      if (method !== 'GET') {
        const ok = await requestApproval(
          {
            title: `${method} request to ${new URL(url).hostname}?`,
            detail: `${method} ${url}${body ? `\n\n${JSON.stringify(body, null, 2).slice(0, 1500)}` : ''}`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        if (!ok) return { error: 'The user declined' };
      }
      const value = /^authorization$/i.test(cred.header) && !/\s/.test(cred.key) ? `Bearer ${cred.key}` : cred.key;
      const res = await safeFetch(url, {
        method,
        headers: { [cred.header]: value, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
        sameOrigin: true,
      });
      const text = (await res.text()).split(cred.key).join('[key]');
      let parsed: unknown = text.slice(0, 20000);
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body: parsed };
    },
  }),
});
