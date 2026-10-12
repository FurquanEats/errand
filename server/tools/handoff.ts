import { tool } from 'ai';
import { z } from 'zod';
import { runHandoff } from '../handoff/agent.ts';
import { listItems as listVault } from '../vault.ts';
import { postUpdate } from '../chat.ts';
import type { ToolContext } from './index.ts';

export const handoffTools = (ctx: ToolContext) => ({
  handoff: tool({
    description:
      'Hand a task to the browser agent, which operates real websites end to end: ordering, booking, applying, forms, account changes, research behind logins. ' +
      'It signs in with vault logins, can create accounts, reads verification codes from the user’s email, and asks the user for anything else. ' +
      'The browser agent cannot see this chat, its attachments or your memory of it: write a complete, self-contained goal with everything it needs (names, the exact items, address, dates, budget, preferences) and, to upload something, the exact file name from file_list. ' +
      'Make documents yourself first (create_document), then hand off the website part. ' +
      'Set background=true for long or parallel jobs (e.g. "apply to these five roles"): you get control back immediately and each result is posted to this chat when done.',
    inputSchema: z.object({ goal: z.string(), start_url: z.string().optional(), background: z.boolean().optional() }),
    execute: async ({ goal, start_url, background }) => {
      const cid = ctx.conversationId;
      if (background && cid) {
        let started = '';
        const done = runHandoff({ goal, startUrl: start_url, conversationId: cid, onCreated: (hid) => ((started = hid), ctx.onHandoff?.(hid)) });
        void done.then((r) =>
          postUpdate(
            cid,
            `Background task ${r.status}: “${goal}”\nResult: ${r.result}${r.notes.length ? `\nNotes: ${r.notes.join('; ')}` : ''}${r.files.length ? `\nFiles: ${r.files.map((f) => `[${f.name}](${f.url})`).join(', ')}` : ''}`,
          ),
        );
        return { handoff_id: started, status: 'running in background', note: 'You will receive the result as a task update in this chat.' };
      }
      const r = await runHandoff({ goal, startUrl: start_url, conversationId: cid, signal: ctx.signal, onCreated: ctx.onHandoff });
      return { handoff_id: r.id, status: r.status, result: r.result, notes: r.notes, files: r.files };
    },
  }),
  browser_sign_in: tool({
    description:
      'Open a website in Errand’s browser for the user to sign in themselves (Google, Zepto, LinkedIn, their bank…). Errand’s browser remembers the session for future tasks. Use when they ask to set up an account for Errand, or before tasks that need a login they haven’t done yet.',
    inputSchema: z.object({ url: z.string().describe('the site’s sign-in page or home page, e.g. https://accounts.google.com') }),
    execute: async ({ url }) => {
      const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      let started = '';
      void runHandoff({
        goal: `Sign in to ${new URL(target).hostname.replace(/^www\./, '')}`,
        startUrl: target,
        signIn: true,
        conversationId: ctx.conversationId,
        onCreated: (hid) => ((started = hid), ctx.onHandoff?.(hid)),
      });
      await new Promise((r) => setTimeout(r, 50));
      return {
        handoff_id: started,
        note: 'The page is open in the browser column with the user in control. Tell them to sign in there and press “Hand back to Errand” when done.',
      };
    },
  }),
  vault_list: tool({
    description: 'List saved logins, cards and identities by label (never values). The browser agent can use them.',
    inputSchema: z.object({}),
    execute: async () => listVault().map((v) => ({ label: v.label, kind: v.kind, domain: v.domain, hint: v.hint })),
  }),
});
