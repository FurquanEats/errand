import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  emailEnabled,
  flagEmail,
  googleToken,
  listAccounts,
  listFolders,
  markRead,
  moveEmail,
  readEmail,
  searchEmail,
  sendEmail,
} from '../connectors/email.ts';
import { createGmailFilter } from '../connectors/google.ts';
import { requestApproval } from '../approvals.ts';
import { bulkAction, senderOverview, unsubscribe } from '../connectors/inbox.ts';
import type { ToolContext } from './index.ts';

/** Email across every connected mailbox. Message ids look like "ab12cd34:5678". */
export function emailTools(ctx: ToolContext): ToolSet {
  if (!emailEnabled()) return {};
  const accounts = listAccounts()
    .map((a) => a.address)
    .join(', ');
  return {
    email_search: tool({
      description: `Search email across connected accounts (${accounts}). Optionally limit to one account.`,
      inputSchema: z.object({
        query: z.string().optional(),
        from: z.string().optional(),
        unread_only: z.boolean().optional(),
        since_days: z.number().optional(),
        account: z.string().optional().describe('email address of one connected account'),
      }),
      execute: async (i) => {
        const found = await searchEmail({ query: i.query, from: i.from, unreadOnly: i.unread_only, sinceDays: i.since_days, account: i.account });
        if (found.some((m) => m.id)) return found;
        // Nothing here often means it lives in another inbox: say where you looked and offer to add one.
        return {
          results: found,
          searched: i.account ?? accounts,
          note: 'Nothing matched. Tell the user which account(s) you searched and the time range, ask whether it might be in another email account, and offer connect_account (google for Gmail, microsoft for Outlook, email for others) so they can add it in one tap.',
        };
      },
    }),
    email_read: tool({
      description: 'Read one email by id. Includes links found in it.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => readEmail(id),
    }),
    email_mark_read: tool({
      description: 'Mark an email as read.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => (await markRead(id), { ok: true }),
    }),
    email_folders: tool({
      description: 'List mail folders/labels of an account.',
      inputSchema: z.object({ account: z.string().optional() }),
      execute: async ({ account }) => listFolders(account),
    }),
    email_move: tool({
      description: 'File an email into a folder/label to organize the inbox (e.g. "Receipts", "Travel", "Alerts/Wheelness"). Creates it if missing.',
      inputSchema: z.object({ id: z.string(), folder: z.string() }),
      execute: async ({ id, folder }) => moveEmail(id, folder),
    }),
    email_flag: tool({
      description: 'Star/flag (or unflag) an email for follow-up.',
      inputSchema: z.object({ id: z.string(), flagged: z.boolean().default(true) }),
      execute: async ({ id, flagged }) => (await flagEmail(id, flagged), { ok: true }),
    }),
    email_senders: tool({
      description: 'Scan the inbox and group mail by sender (counts, unread, unsubscribe available). Use before cleaning up, to build a plan.',
      inputSchema: z.object({ account: z.string().optional(), since_days: z.number().optional() }),
      execute: async ({ account, since_days }) => senderOverview({ account, sinceDays: since_days }),
    }),
    email_cleanup: tool({
      description:
        'Bulk-handle all mail from given senders: trash (recoverable), archive, move to a folder/label, or mark read. ' +
        'Always run email_senders first and present the plan; the user approves the exact list before anything happens.',
      inputSchema: z.object({
        action: z.enum(['trash', 'archive', 'move', 'mark_read']),
        senders: z.array(z.string()).min(1),
        folder: z.string().optional(),
        account: z.string().optional(),
        summary: z.string().describe('one line describing the plan for the user'),
      }),
      execute: async ({ action, senders, folder, account, summary }) => {
        const verb = { trash: 'Move to Trash', archive: 'Archive', move: `Move to “${folder}”`, mark_read: 'Mark as read' }[action];
        const ok = await requestApproval(
          {
            title: `${verb}: all mail from ${senders.length} sender${senders.length === 1 ? '' : 's'}?`,
            detail: `${summary}\n\n${senders.join('\n')}`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        return ok ? bulkAction({ action, senders, folder, account }) : { done: false, reason: 'The user declined' };
      },
    }),
    email_unsubscribe: tool({
      description: 'Unsubscribe from mailing lists using their official unsubscribe mechanism (one-click or email). Asks first.',
      inputSchema: z.object({ senders: z.array(z.string()).min(1) }),
      execute: async ({ senders }) => {
        const ok = await requestApproval(
          {
            title: `Unsubscribe from ${senders.length} sender${senders.length === 1 ? '' : 's'}?`,
            detail: senders.join('\n'),
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        if (!ok) return { done: false, reason: 'The user declined' };
        return unsubscribe(senders, (to, subject, from) => sendEmail({ from, to, subject, body: 'unsubscribe' }));
      },
    }),
    email_filter: tool({
      description:
        'Gmail only: create a filter so future mail matching a sender or search is labeled automatically (and optionally skips the inbox). Pair with email_cleanup to file existing mail.',
      inputSchema: z.object({
        account: z.string().optional(),
        from: z.string().optional(),
        query: z.string().optional(),
        label: z.string(),
        skip_inbox: z.boolean().default(true),
      }),
      execute: async ({ account, from, query, label, skip_inbox }) => {
        // A filter keeps acting on future mail, so it is never created without your OK.
        const ok = await requestApproval(
          {
            title: `Create a Gmail filter?`,
            detail: `Mail ${from ? `from ${from}` : `matching “${query ?? ''}”`} will be labelled “${label}”${skip_inbox ? ' and skip your inbox' : ''}, from now on.`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        if (!ok) return { created: false, note: 'The user declined' };
        const { address, token } = await googleToken(account);
        return { account: address, ...(await createGmailFilter(token, { from, query, label, skipInbox: skip_inbox })) };
      },
    }),
    email_send_many: tool({
      description: 'Send several personalized emails at once (e.g. a note to each investor). The user approves the whole batch in one step.',
      inputSchema: z.object({
        from: z.string().optional(),
        messages: z
          .array(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
          .min(1)
          .max(100),
      }),
      execute: async ({ from, messages }) => {
        const preview = messages
          .slice(0, 3)
          .map((m) => `To: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`)
          .join('\n\n―――\n\n');
        const ok = await requestApproval(
          {
            title: `Send ${messages.length} emails?`,
            detail: `Recipients: ${messages.map((m) => m.to).join(', ')}\n\n${preview}${messages.length > 3 ? `\n\n…and ${messages.length - 3} more like these` : ''}`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        if (!ok) return { sent: 0, reason: 'The user declined' };
        const results = [];
        for (const m of messages)
          results.push(
            await sendEmail({ from, ...m })
              .then(() => ({ to: m.to, sent: true }))
              .catch((e: Error) => ({ to: m.to, sent: false, error: e.message })),
          );
        return { sent: results.filter((r) => r.sent).length, results };
      },
    }),
    email_send: tool({
      description: 'Send an email (the user approves the exact text first). Choose the sending account with "from".',
      inputSchema: z.object({
        from: z.string().optional().describe(`one of: ${accounts}`),
        to: z.string(),
        cc: z.string().optional(),
        subject: z.string(),
        body: z.string(),
        in_reply_to: z.string().optional(),
      }),
      execute: async (i) => {
        const ok = await requestApproval(
          {
            title: 'Send this email?',
            detail: `From: ${i.from ?? listAccounts()[0]?.address}\nTo: ${i.to}${i.cc ? `\nCc: ${i.cc}` : ''}\nSubject: ${i.subject}\n\n${i.body}`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        if (!ok) return { sent: false, reason: 'The user declined' };
        return { sent: true, ...(await sendEmail({ ...i, inReplyTo: i.in_reply_to })) };
      },
    }),
  };
}
