import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { all, get, id, insert, now, parseJSON, patch, run } from '../db.ts';
import { publish } from '../bus.ts';
import { VERSION } from '../updates.ts';
import { requestApproval } from '../approvals.ts';

/**
 * MCP (Model Context Protocol) is how Errand connects to everything else: Slack, Spotify,
 * Strava, GitHub, Notion, Google Workspace, Home Assistant... any MCP server works.
 */

export interface McpServerRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: number;
  approval: number;
  created_at: number;
}

interface Live {
  client: Client;
  tools: { name: string; description?: string; inputSchema: any }[];
  error?: string;
}

const live = new Map<string, Live>();
const errors = new Map<string, string>();

export function listServers() {
  return all<McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at').map((s) => ({
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    args: parseJSON<string[]>(s.args, []),
    env: parseJSON<Record<string, string>>(s.env, {}),
    url: s.url ?? '',
    headers: parseJSON<Record<string, string>>(s.headers, {}),
    enabled: !!s.enabled,
    approval: !!s.approval,
    connected: live.has(s.id),
    error: errors.get(s.id) ?? '',
    tools: live.get(s.id)?.tools.map((t) => t.name) ?? [],
  }));
}

export async function addServer(input: {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}) {
  const sid = id();
  insert('mcp_servers', {
    id: sid,
    name: input.name,
    transport: input.transport,
    command: input.command ?? null,
    args: JSON.stringify(input.args ?? []),
    env: JSON.stringify(input.env ?? {}),
    url: input.url ?? null,
    headers: JSON.stringify(input.headers ?? {}),
    enabled: 1,
    created_at: now(),
  });
  await connect(sid);
  return sid;
}

export async function updateServer(
  sid: string,
  input: Partial<{
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    url: string;
    headers: Record<string, string>;
    enabled: boolean;
    approval: boolean;
  }>,
) {
  patch(
    'mcp_servers',
    sid,
    {
      name: input.name,
      command: input.command,
      args: input.args && JSON.stringify(input.args),
      env: input.env && JSON.stringify(input.env),
      url: input.url,
      headers: input.headers && JSON.stringify(input.headers),
      enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
      approval: input.approval === undefined ? undefined : input.approval ? 1 : 0,
    },
    ['name', 'command', 'args', 'env', 'url', 'headers', 'enabled', 'approval'],
  );
  if (input.approval !== undefined && Object.keys(input).length === 1) return publish({ type: 'mcp.updated' });
  await disconnect(sid);
  if (input.enabled !== false) await connect(sid);
}

export async function removeServer(sid: string) {
  await disconnect(sid);
  run('DELETE FROM mcp_servers WHERE id = ?', sid);
  publish({ type: 'mcp.updated' });
}

async function disconnect(sid: string) {
  const l = live.get(sid);
  live.delete(sid);
  errors.delete(sid);
  await l?.client.close().catch(() => {});
}

export async function connect(sid: string) {
  const row = get<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', sid);
  if (!row || !row.enabled) return;
  try {
    const client = new Client({ name: 'errand', version: VERSION });
    const transport =
      row.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(row.url ?? ''), { requestInit: { headers: parseJSON(row.headers, {}) } })
        : new StdioClientTransport({
            command: row.command ?? '',
            args: parseJSON<string[]>(row.args, []),
            env: { ...getDefaultEnvironment(), ...parseJSON<Record<string, string>>(row.env, {}) },
            stderr: 'ignore',
          });
    await client.connect(transport);
    const { tools } = await client.listTools();
    live.set(sid, { client, tools });
    errors.delete(sid);
  } catch (err) {
    errors.set(sid, (err as Error).message);
    console.warn(`[mcp] ${row.name}: ${(err as Error).message}`);
  }
  publish({ type: 'mcp.updated' });
}

export async function connectAll() {
  await Promise.all(all<McpServerRow>('SELECT * FROM mcp_servers WHERE enabled = 1').map((s) => connect(s.id)));
}

const safe = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 24);

/**
 * Expose every connected MCP tool to the model as `mcp_<server>_<tool>`. Servers marked
 * "ask first" require approval for each call and are excluded from unattended (read-only) runs.
 */
export function mcpTools(ctx: { conversationId?: string; signal?: AbortSignal; unattended?: boolean } = {}): ToolSet {
  const tools: ToolSet = {};
  const rows = all<McpServerRow>('SELECT id, name, approval FROM mcp_servers');
  for (const [sid, l] of live) {
    const row = rows.find((r) => r.id === sid);
    const server = row?.name ?? 'server';
    const ask = !!row?.approval;
    if (ask && ctx.unattended) continue;
    for (const t of l.tools) {
      const name = `mcp_${safe(server)}_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
      tools[name] = dynamicTool({
        description: `[${server}] ${t.description ?? t.name}`.slice(0, 1024),
        inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {} }),
        execute: async (input) => {
          if (ask) {
            const ok = await requestApproval(
              { title: `Allow ${server} to run “${t.name}”?`, detail: JSON.stringify(input ?? {}, null, 2), conversationId: ctx.conversationId },
              ctx.signal,
            );
            if (!ok) return { error: 'The user declined this action' };
          }
          const res: any = await l.client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> });
          const text = (res.content ?? [])
            .map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource) : `[${c.type}]`))
            .join('\n');
          return res.isError ? { error: text } : (res.structuredContent ?? text);
        },
      });
    }
  }
  return tools;
}

/** Names of all connected MCP tools, for prompts that need to know what data sources exist. */
export function mcpToolSummary(): string {
  const names = Object.keys(mcpTools());
  return names.length ? names.join(', ') : 'none';
}
