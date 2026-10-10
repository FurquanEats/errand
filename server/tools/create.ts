import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { all, get } from '../db.ts';
import { buildPresentation, storeFile } from '../documents.ts';
import { getSettings } from '../settings.ts';
import { requestApproval } from '../approvals.ts';
import type { ToolContext } from './index.ts';

/** Making things: presentations, files, usage numbers, and (opt-in) running commands on this computer. */
export const createTools = (ctx: ToolContext) => ({
  usage_stats: tool({
    description: 'Numbers about how the user has used Errand over a period: messages, conversations, browser tasks (by status), routines run, memories.',
    inputSchema: z.object({ days: z.number().default(60) }),
    execute: async ({ days }) => {
      const since = Date.now() - days * 86400_000;
      const byWeek = all<{ week: string; n: number }>(
        "SELECT strftime('%Y-%W', created_at / 1000, 'unixepoch') AS week, COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at > ? GROUP BY week ORDER BY week",
        since,
      );
      return {
        days,
        messages: get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at > ?", since)?.n ?? 0,
        conversations: get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE created_at > ?', since)?.n ?? 0,
        handoffs: all('SELECT status, COUNT(*) AS n FROM handoffs WHERE created_at > ? GROUP BY status', since),
        handoffsByWeek: all(
          "SELECT strftime('%Y-%W', created_at / 1000, 'unixepoch') AS week, COUNT(*) AS n FROM handoffs WHERE created_at > ? GROUP BY week ORDER BY week",
          since,
        ),
        messagesByWeek: byWeek,
        memories: get<{ n: number }>('SELECT COUNT(*) AS n FROM memories')?.n ?? 0,
      };
    },
  }),
  make_presentation: tool({
    description:
      'Create a slide deck (keynote-style, opens in the browser). Each slide can have bullets, a big stat, or a bar/line chart. Gather the data first.',
    inputSchema: z.object({
      title: z.string(),
      slides: z
        .array(
          z.object({
            title: z.string(),
            subtitle: z.string().optional(),
            bullets: z.array(z.string()).optional(),
            stat: z.object({ value: z.string(), label: z.string() }).optional(),
            chart: z
              .object({ type: z.enum(['bar', 'line']), labels: z.array(z.string()), values: z.array(z.number()), unit: z.string().optional() })
              .optional(),
          }),
        )
        .min(1)
        .max(30),
    }),
    execute: async ({ title, slides }) => {
      const file = buildPresentation(title, slides);
      return { file, action: { label: `Open “${title}”`, url: file.url, note: `${slides.length} slides` } };
    },
  }),
  save_file: tool({
    description: 'Save text content (CSV, markdown, JSON, notes) as a downloadable file for the user.',
    inputSchema: z.object({ name: z.string().describe('file name with extension'), content: z.string() }),
    execute: async ({ name, content }) => {
      const file = storeFile(name, content);
      return { file, action: { label: `Download ${file.name}`, url: file.url, note: '' } };
    },
  }),
  ...(getSettings().computer.allowCommands
    ? {
        run_command: tool({
          description:
            'Run a shell command on the user’s computer (enabled by the user in Settings). The user approves every command. Use for local tasks: opening apps, file management, scripts.',
          inputSchema: z.object({ command: z.string(), cwd: z.string().optional(), reason: z.string() }),
          execute: async ({ command, cwd, reason }) => {
            const ok = await requestApproval(
              {
                title: 'Run this command on your computer?',
                detail: `${reason}\n\n$ ${command}${cwd ? `\n(in ${cwd})` : ''}`,
                conversationId: ctx.conversationId,
              },
              ctx.signal,
            );
            if (!ok) return { ran: false, reason: 'The user declined' };
            return new Promise((resolve) => {
              exec(command, { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
                resolve({ ran: true, exitCode: err && 'code' in err ? err.code : 0, stdout: stdout.slice(-8000), stderr: stderr.slice(-4000) }),
              );
            });
          },
        }),
      }
    : {}),
});
