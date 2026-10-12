import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { all, get } from '../db.ts';
import fs from 'node:fs';
import { buildPresentation, listStoredFiles, readStoredFile, storeFile } from '../documents.ts';
import { makeDocument, readDocument } from '../office.ts';
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
  create_document: tool({
    description:
      'Make a real document for the user to download: a résumé or CV, cover letter, report, letter, invoice, itinerary, notes. Write the full content as Markdown (# name/title, ## sections, lists, **bold**, tables, links) and pick the formats: pdf and docx are the usual pair; html, md, csv also work. ' +
      'style resume is compact and one-page friendly; letter suits cover letters; document for everything else. The files are saved, so the browser agent can upload them (e.g. a CV to a job form).',
    inputSchema: z.object({
      title: z.string().describe('file name without extension, e.g. "Mohammed Furquan – Resume"'),
      content: z.string().describe('the whole document in Markdown'),
      formats: z
        .array(z.enum(['pdf', 'docx', 'html', 'md', 'csv']))
        .min(1)
        .default(['pdf', 'docx']),
      style: z.enum(['document', 'resume', 'letter']).default('document'),
    }),
    execute: async ({ title, content, formats, style }) => {
      // PDF first: the Word file uses the same sizing the PDF needed to fit.
      const order = [...new Set(formats)].sort((a, b) => (a === 'pdf' ? -1 : b === 'pdf' ? 1 : 0));
      const files = [];
      let scale = 1;
      let pages: number | undefined;
      for (const format of order) {
        const made = await makeDocument({ title, format, content, style, scale });
        if (made.scale) scale = made.scale;
        if (made.pages) pages = made.pages;
        files.push(made.file);
      }
      return {
        files,
        pages,
        note:
          style === 'resume' && pages && pages > 1
            ? `The PDF is ${pages} pages even at the tightest readable size. If the user wants one page, shorten it (fewer, tighter bullets; drop the least relevant items) and make it again.`
            : 'Link each file for the user with its url.',
      };
    },
  }),
  file_list: tool({
    description:
      'Files the user gave Errand (attachments) or Errand made (documents, downloads, screenshots), newest first. Use it to find "my resume" and similar.',
    inputSchema: z.object({}),
    execute: async () => listStoredFiles(40).map((f) => ({ name: f.name, size: f.size, url: f.url })),
  }),
  file_read: tool({
    description: 'Read the text of a file from file_list (PDF, Word, text, CSV, Markdown), e.g. the user’s current résumé before rewriting it.',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const f =
        listStoredFiles(200).find((x) => x.name.toLowerCase() === name.toLowerCase()) ??
        listStoredFiles(200).find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
      const stored = f && readStoredFile(f.id);
      if (!stored) return { error: `No file named "${name}". Call file_list to see the names.` };
      const text = await readDocument(stored.name, stored.mime, fs.readFileSync(stored.path));
      return text === null ? { error: 'That file has no readable text (an image or a scanned PDF).' } : { name: stored.name, text: text.slice(0, 60_000) };
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
