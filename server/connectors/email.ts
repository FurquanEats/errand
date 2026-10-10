import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { all, get, id as newId, insert, now, parseJSON, run } from '../db.ts';
import { seal, unseal } from '../crypto.ts';
import { publish } from '../bus.ts';
import { accessToken } from './google.ts';
import { microsoftAccessToken, OUTLOOK } from './microsoft.ts';

/**
 * Any number of mailboxes: Google accounts via "Connect Google" (OAuth), Outlook/Hotmail/Microsoft 365
 * via "Continue with Microsoft" (OAuth), or any provider over
 * IMAP/SMTP with an app password (Outlook, iCloud, Fastmail, Zoho, Yahoo, your own server).
 * Messages are addressed as "<account-prefix>:<uid>" so tools can work across all of them.
 */

export interface EmailAccount {
  id: string;
  kind: 'google' | 'microsoft' | 'imap';
  address: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

interface AccountRow {
  id: string;
  kind: 'google' | 'microsoft' | 'imap';
  address: string;
  display_name: string;
  config: string;
  secret: string;
  created_at: number;
}

const GMAIL = { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true };

function toAccount(r: AccountRow): EmailAccount {
  const cfg = r.kind === 'google' ? GMAIL : r.kind === 'microsoft' ? OUTLOOK : parseJSON(r.config, GMAIL);
  return { id: r.id, kind: r.kind, address: r.address, displayName: r.display_name, ...cfg };
}

export const listAccounts = () => all<AccountRow>('SELECT * FROM email_accounts ORDER BY created_at').map(toAccount);
export const emailEnabled = () => !!get('SELECT 1 AS x FROM email_accounts LIMIT 1');

export function upsertGoogleAccount(email: string, name: string, refreshToken: string) {
  const existing = get<AccountRow>("SELECT * FROM email_accounts WHERE kind = 'google' AND lower(address) = lower(?)", email);
  if (existing) run('UPDATE email_accounts SET secret = ?, display_name = ? WHERE id = ?', seal(refreshToken), name, existing.id);
  else
    insert('email_accounts', { id: newId(), kind: 'google', address: email, display_name: name, config: '{}', secret: seal(refreshToken), created_at: now() });
  publish({ type: 'accounts.updated' });
}

export function upsertMicrosoftAccount(address: string, name: string, refreshToken: string) {
  const existing = get<AccountRow>("SELECT * FROM email_accounts WHERE kind = 'microsoft' AND lower(address) = lower(?)", address);
  if (existing) run('UPDATE email_accounts SET secret = ?, display_name = ? WHERE id = ?', seal(refreshToken), name, existing.id);
  else insert('email_accounts', { id: newId(), kind: 'microsoft', address, display_name: name, config: '{}', secret: seal(refreshToken), created_at: now() });
  publish({ type: 'accounts.updated' });
}

export async function addImapAccount(input: Omit<EmailAccount, 'id' | 'kind'> & { password: string }) {
  const { password, address, displayName, ...cfg } = input;
  const acc: EmailAccount = { id: newId(), kind: 'imap', address, displayName, ...cfg };
  await withImap(acc, async () => {}, password); // fail fast on wrong credentials
  insert('email_accounts', {
    id: acc.id,
    kind: 'imap',
    address,
    display_name: displayName,
    config: JSON.stringify(cfg),
    secret: seal(password),
    created_at: now(),
  });
  publish({ type: 'accounts.updated' });
  return acc.id;
}

export function removeAccount(accountId: string) {
  run('DELETE FROM email_accounts WHERE id = ?', accountId);
  publish({ type: 'accounts.updated' });
}

/** Access token for a connected Google account (first one if none given), for Calendar/Drive calls. */
export async function googleToken(address?: string): Promise<{ address: string; token: string }> {
  const accounts = listAccounts().filter((a) => a.kind === 'google');
  const acc = address ? accounts.find((a) => a.address.toLowerCase() === address.toLowerCase()) : accounts[0];
  if (!acc) throw new Error(address ? `${address} is not a connected Google account` : 'No Google account is connected.');
  const row = get<AccountRow>('SELECT * FROM email_accounts WHERE id = ?', acc.id);
  return { address: acc.address, token: await accessToken(acc.address, unseal(row?.secret)) };
}

export const googleConnected = () => listAccounts().some((a) => a.kind === 'google');

async function authFor(acc: EmailAccount, password?: string) {
  const row = get<AccountRow>('SELECT * FROM email_accounts WHERE id = ?', acc.id);
  if (acc.kind === 'google') return { user: acc.address, accessToken: await accessToken(acc.address, unseal(row?.secret)) };
  if (acc.kind === 'microsoft')
    return {
      user: acc.address,
      accessToken: await microsoftAccessToken(acc.address, unseal(row?.secret), (next) =>
        run('UPDATE email_accounts SET secret = ? WHERE id = ?', seal(next), acc.id),
      ),
    };
  return { user: acc.address, pass: password ?? unseal(row?.secret) };
}

async function withImap<T>(acc: EmailAccount, fn: (client: ImapFlow) => Promise<T>, password?: string, mailbox = 'INBOX'): Promise<T> {
  const client = new ImapFlow({ host: acc.imapHost, port: acc.imapPort, secure: acc.imapSecure, auth: await authFor(acc, password), logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Run IMAP work against one account and mailbox (inbox cleanup, noticing things in new mail). */
export const withAccountImap = <T>(acc: EmailAccount, fn: (client: ImapFlow) => Promise<T>, mailbox = 'INBOX') => withImap(acc, fn, undefined, mailbox);

/** Resolve "abcd1234:5678" (or an account address) into an account and uid. */
function resolve(messageId: string): { acc: EmailAccount; uid: number } {
  const [prefix, uid] = messageId.split(':');
  const acc = listAccounts().find((a) => a.id.startsWith(prefix));
  if (!acc || !uid) throw new Error(`Unknown message id "${messageId}"`);
  return { acc, uid: Number(uid) };
}

function pickAccount(address?: string): EmailAccount {
  const accounts = listAccounts();
  if (!accounts.length) throw new Error('No email account is connected. Connect one in Settings → Accounts.');
  if (!address) return accounts[0];
  const acc = accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
  if (!acc) throw new Error(`No connected account ${address}. Connected: ${accounts.map((a) => a.address).join(', ')}`);
  return acc;
}

export interface EmailSummary {
  id: string;
  account: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
}

export async function searchEmail(opts: {
  query?: string;
  from?: string;
  unreadOnly?: boolean;
  sinceDays?: number;
  sinceMinutes?: number;
  limit?: number;
  account?: string;
}) {
  const accounts = opts.account ? [pickAccount(opts.account)] : listAccounts();
  const since = new Date(Date.now() - (opts.sinceMinutes ? opts.sinceMinutes * 60_000 : (opts.sinceDays ?? 30) * 86400_000));
  const results = await Promise.all(
    accounts.map((acc) =>
      withImap(acc, async (client) => {
        const criteria: any = { since };
        if (opts.query) criteria.or = [{ subject: opts.query }, { body: opts.query }, { from: opts.query }];
        if (opts.from) criteria.from = opts.from;
        if (opts.unreadOnly) criteria.seen = false;
        const uids = ((await client.search(criteria, { uid: true })) || []).slice(-(opts.limit ?? 20));
        const out: EmailSummary[] = [];
        if (!uids.length) return out;
        for await (const msg of client.fetch(uids, { envelope: true, flags: true, uid: true, internalDate: true }, { uid: true })) {
          out.push({
            id: `${acc.id.slice(0, 8)}:${msg.uid}`,
            account: acc.address,
            from: (msg.envelope?.from ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
            subject: msg.envelope?.subject ?? '(no subject)',
            date: new Date(msg.internalDate ?? msg.envelope?.date ?? Date.now()).toISOString(),
            unread: !msg.flags?.has('\\Seen'),
          });
        }
        return out;
      }).catch((err) => [{ id: '', account: acc.address, from: '', subject: `⚠ ${(err as Error).message}`, date: '', unread: false }]),
    ),
  );
  return results
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, opts.limit ?? 20);
}

const addr = (a: any) => (a ? ((a.value ?? []) as any[]).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ') : '');

export async function readEmail(messageId: string) {
  const { acc, uid } = resolve(messageId);
  return withImap(acc, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message not found');
    const parsed = await simpleParser(msg.source);
    const links = [...new Set(String(parsed.html || parsed.textAsHtml || '').match(/https?:\/\/[^\s"'<>]+/g) ?? [])].slice(0, 40);
    return {
      id: messageId,
      account: acc.address,
      from: addr(parsed.from),
      to: addr(parsed.to),
      cc: addr(parsed.cc),
      subject: parsed.subject ?? '',
      date: parsed.date?.toISOString() ?? '',
      messageId: parsed.messageId ?? '',
      text: (parsed.text ?? '').slice(0, 15000),
      links,
      attachments: parsed.attachments.map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
    };
  });
}

export async function markRead(messageId: string) {
  const { acc, uid } = resolve(messageId);
  await withImap(acc, (client) => client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }));
}

export async function flagEmail(messageId: string, flagged: boolean) {
  const { acc, uid } = resolve(messageId);
  await withImap(acc, (client) =>
    flagged ? client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true }),
  );
}

/** Move a message to a folder (a label in Gmail). Creates it if needed. */
export async function moveEmail(messageId: string, folder: string) {
  const { acc, uid } = resolve(messageId);
  return withImap(acc, async (client) => {
    if (!(await client.list()).some((m) => m.path === folder)) await client.mailboxCreate(folder);
    return { moved: !!(await client.messageMove(String(uid), folder, { uid: true })), folder };
  });
}

export async function listFolders(account?: string) {
  const acc = pickAccount(account);
  return withImap(acc, async (client) => (await client.list()).map((m) => ({ path: m.path, specialUse: m.specialUse ?? '' })));
}

export async function sendEmail(opts: {
  from?: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}) {
  const acc = pickAccount(opts.from);
  const auth = await authFor(acc);
  const transport = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: 'accessToken' in auth ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
  });
  const info = await transport.sendMail({
    from: acc.displayName ? `"${acc.displayName}" <${acc.address}>` : acc.address,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.body,
    inReplyTo: opts.inReplyTo,
    references: opts.inReplyTo,
    attachments: opts.attachments,
  });
  return { from: acc.address, messageId: info.messageId, accepted: info.accepted };
}

export async function testAccount(accountId: string) {
  const acc = listAccounts().find((a) => a.id === accountId);
  if (!acc) throw new Error('Account not found');
  const recent = await searchEmail({ account: acc.address, sinceDays: 3, limit: 3 });
  return { ok: true, sample: recent.map((m) => m.subject) };
}

// ── Verification codes & links (how the browser agent handles OTP) ───────────

const CODE_PATTERNS = [
  /(?:code|otp|passcode|pin|verification|security code|one[- ]time)[^\d]{0,40}?(\b\d{4,8}\b)/i,
  /(\b\d{4,8}\b)[^\d]{0,30}(?:is your|is the)\s+(?:code|otp|verification)/i,
  /(?:code|otp)[^A-Z0-9]{0,20}\b([A-Z0-9]{6})\b/,
];
const LINK_HINT = /verif|confirm|activate|validate|magic|sign[-_]?in|login|token|auth/i;

/**
 * Look for a recent verification email from a site. Returns the code and/or candidate links.
 * Only messages that mention the site (in sender or subject) are considered.
 */
export async function findVerification(site: string, sinceMinutes = 20) {
  if (!emailEnabled()) return null;
  const needle =
    site
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.')
      .slice(-2, -1)[0] || site.toLowerCase();
  const recent = await searchEmail({ sinceMinutes, limit: 15 });
  for (const m of recent) {
    if (!m.id || !`${m.from} ${m.subject}`.toLowerCase().includes(needle)) continue;
    const full = await readEmail(m.id);
    const haystack = `${full.subject}\n${full.text}`;
    let code: string | undefined;
    for (const re of CODE_PATTERNS) {
      const hit = haystack.match(re);
      if (hit) {
        code = hit[1];
        break;
      }
    }
    const links = full.links.filter((l) => LINK_HINT.test(l) && !/unsubscribe|privacy|terms/i.test(l)).slice(0, 5);
    if (code || links.length) return { from: full.from, subject: full.subject, account: full.account, received: m.date, code, links };
  }
  return null;
}

/** One-time migration from the single-account settings of earlier versions. */
export function migrateLegacySettings(legacy: any) {
  if (!legacy?.enabled || !legacy.imapHost || !legacy.user || emailEnabled()) return;
  insert('email_accounts', {
    id: newId(),
    kind: 'imap',
    address: legacy.user,
    display_name: legacy.fromName ?? '',
    config: JSON.stringify({
      imapHost: legacy.imapHost,
      imapPort: legacy.imapPort,
      imapSecure: legacy.imapSecure,
      smtpHost: legacy.smtpHost,
      smtpPort: legacy.smtpPort,
      smtpSecure: legacy.smtpSecure,
    }),
    secret: legacy.password ?? '',
    created_at: now(),
  });
}
