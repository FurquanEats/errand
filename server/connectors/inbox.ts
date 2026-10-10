import { ImapFlow } from 'imapflow';
import { listAccounts, withAccountImap, type EmailAccount } from './email.ts';
import { safeFetch } from '../security.ts';

/**
 * Inbox cleanup at scale: see who fills your inbox, bulk-trash or archive by sender, and
 * unsubscribe using the standard List-Unsubscribe header (RFC 2369 / one-click RFC 8058).
 * Nothing is permanently deleted: "trash" moves mail to the provider's Trash folder.
 */

export interface SenderStat {
  account: string;
  sender: string;
  name: string;
  count: number;
  unread: number;
  latestSubject: string;
  latestDate: string;
  unsubscribe: boolean;
}

const senderOf = (env: any) => {
  const a = env?.from?.[0];
  return { address: String(a?.address ?? '').toLowerCase(), name: String(a?.name ?? '') };
};

/** Group recent mail by sender. Scans up to `max` messages per account. */
export async function senderOverview(opts: { account?: string; sinceDays?: number; max?: number } = {}) {
  const accounts = listAccounts().filter((a) => !opts.account || a.address.toLowerCase() === opts.account.toLowerCase());
  const since = new Date(Date.now() - (opts.sinceDays ?? 180) * 86400_000);
  const stats = new Map<string, SenderStat>();
  let scanned = 0;
  for (const acc of accounts) {
    await withAccountImap(acc, async (client) => {
      const uids = ((await client.search({ since }, { uid: true })) || []).slice(-(opts.max ?? 3000));
      if (!uids.length) return;
      for await (const msg of client.fetch(uids, { envelope: true, flags: true, uid: true, headers: ['list-unsubscribe'] }, { uid: true })) {
        scanned++;
        const { address, name } = senderOf(msg.envelope);
        if (!address) continue;
        const key = `${acc.address}|${address}`;
        const s = stats.get(key) ?? { account: acc.address, sender: address, name, count: 0, unread: 0, latestSubject: '', latestDate: '', unsubscribe: false };
        s.count++;
        if (!msg.flags?.has('\\Seen')) s.unread++;
        const date = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '';
        if (date >= s.latestDate) {
          s.latestDate = date;
          s.latestSubject = msg.envelope?.subject ?? '';
        }
        if (msg.headers && /list-unsubscribe/i.test(msg.headers.toString())) s.unsubscribe = true;
        stats.set(key, s);
      }
    });
  }
  const senders = [...stats.values()].sort((a, b) => b.count - a.count);
  return { scanned, senders: senders.slice(0, 150), totalSenders: senders.length };
}

async function specialFolder(client: ImapFlow, use: '\\Trash' | '\\Archive' | '\\All') {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === use)?.path;
}

/** Trash, archive, move or mark-read every message from the given senders. */
export async function bulkAction(opts: { action: 'trash' | 'archive' | 'move' | 'mark_read'; senders: string[]; folder?: string; account?: string }) {
  const accounts = listAccounts().filter((a) => !opts.account || a.address.toLowerCase() === opts.account.toLowerCase());
  const results: { account: string; sender: string; affected: number }[] = [];
  for (const acc of accounts) {
    await withAccountImap(acc, async (client) => {
      const trash = await specialFolder(client, '\\Trash');
      const archive = (await specialFolder(client, '\\Archive')) ?? (await specialFolder(client, '\\All'));
      for (const sender of opts.senders) {
        const uids = (await client.search({ from: sender }, { uid: true })) || [];
        if (!uids.length) continue;
        const range = uids.join(',');
        if (opts.action === 'mark_read') await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
        else {
          let target = opts.action === 'trash' ? trash : opts.action === 'archive' ? archive : opts.folder;
          if (!target && opts.action === 'archive') target = 'Archive';
          if (!target) throw new Error(opts.action === 'trash' ? `No Trash folder found for ${acc.address}` : 'A folder name is required');
          if (!(await client.list()).some((b) => b.path === target)) await client.mailboxCreate(target);
          await client.messageMove(range, target, { uid: true });
        }
        results.push({ account: acc.address, sender, affected: uids.length });
      }
    });
  }
  return { results, total: results.reduce((n, r) => n + r.affected, 0) };
}

/** Unsubscribe via List-Unsubscribe: one-click POST, else mailto, else report the link. */
export async function unsubscribe(senders: string[], send: (to: string, subject: string, account: string) => Promise<unknown>) {
  const out: { sender: string; method: string; ok: boolean; detail?: string }[] = [];
  for (const acc of listAccounts()) {
    await withAccountImap(acc, async (client) => {
      for (const sender of senders) {
        if (out.some((o) => o.sender === sender && o.ok)) continue;
        const uids = (await client.search({ from: sender }, { uid: true })) || [];
        const last = uids.at(-1);
        if (!last) continue;
        const msg = await client.fetchOne(String(last), { headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true });
        const headers = msg && msg.headers ? msg.headers.toString() : '';
        const list = headers.match(/list-unsubscribe:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/i)?.[1] ?? '';
        const oneClick = /list-unsubscribe-post:\s*List-Unsubscribe=One-Click/i.test(headers);
        const links = [...list.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
        const http = links.find((l) => /^https:/i.test(l));
        const mailto = links.find((l) => /^mailto:/i.test(l));
        try {
          if (http && oneClick) {
            const res = await safeFetch(http, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: 'List-Unsubscribe=One-Click',
              signal: AbortSignal.timeout(15000),
            });
            out.push({ sender, method: 'one-click', ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` });
          } else if (mailto) {
            const url = new URL(mailto);
            await send(decodeURIComponent(url.pathname), url.searchParams.get('subject') ?? 'unsubscribe', acc.address);
            out.push({ sender, method: 'email', ok: true });
          } else if (http) {
            out.push({ sender, method: 'link', ok: false, detail: `Needs a visit: ${http}` });
          } else out.push({ sender, method: 'none', ok: false, detail: 'No unsubscribe option in the email' });
        } catch (err) {
          out.push({ sender, method: http ? 'one-click' : 'email', ok: false, detail: (err as Error).message });
        }
      }
    });
  }
  return out;
}

export type { EmailAccount };
