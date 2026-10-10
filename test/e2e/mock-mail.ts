/**
 * A real IMAP server (hoodiecrow, in memory) with a lived-in inbox, so the e2e test exercises
 * Errand's whole noticing pipeline: IMAP search and fetch, the rules, the model, the trackers.
 */
import { createRequire } from 'node:module';

const hoodiecrow = createRequire(import.meta.url)('hoodiecrow-imap');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
let n = 0;

export function email(o: { from: string; to?: string; subject: string; body: string; at: number }) {
  return {
    internaldate: new Date(o.at),
    flags: [] as string[],
    raw: [
      `From: ${o.from}`,
      `To: ${o.to ?? 'sam@example.com'}`,
      `Subject: ${o.subject}`,
      `Date: ${new Date(o.at).toUTCString()}`,
      `Message-ID: <e2e-${++n}@example.com>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      o.body,
    ].join('\r\n'),
  };
}

export function seedMail(now = Date.now()) {
  const inbox = [
    // Three CI failures since yesterday.
    ...[20, 9, 2].map((h) =>
      email({
        from: 'GitHub <notifications@github.com>',
        subject: '[acme-e2e/shop] Run failed: CI - main (8825a5d)',
        body: 'Run failed for main (8825a5d)\nView workflow run: https://github.com/acme-e2e/shop/actions/runs/4242',
        at: now - h * HOUR,
      }),
    ),
    // Zomato on the same weekday for four weeks, about 90 minutes later in the day than now.
    ...[1, 2, 3, 4].map((w) =>
      email({
        from: 'Kotak Bank <BankAlerts@kotak.com>',
        subject: 'Card online transaction- Successful',
        body: `Dear Customer, Your transaction of Rs.${540 + w}.00 on ZOMATO LIMITED using Kotak Bank Debit Card XX1234 has been processed.`,
        at: now + 90 * 60_000 - w * 7 * DAY,
      }),
    ),
    email({
      from: 'Raycast <no-reply@greenhouse.io>',
      subject: 'Thank you for applying to Raycast',
      body: 'We received your application for Product Engineer.',
      at: now - 3 * DAY,
    }),
    email({
      from: 'Amazon.in <shipment-tracking@amazon.in>',
      subject: 'Your Amazon.in order #407-1234567 has shipped',
      body: 'Wireless earbuds, arriving Monday.',
      at: now - DAY,
    }),
    email({
      from: 'Airtel <ebill@airtel.com>',
      subject: 'Your Airtel bill is ready',
      body: `Amount due: ₹799. Due date: ${new Date(now + 3 * DAY).toISOString().slice(0, 10)}`,
      at: now - 2 * DAY,
    }),
    email({
      from: 'IndiGo <reservations@goindigo.in>',
      subject: 'Your IndiGo booking is confirmed - PNR ABC123',
      body: `6E 512 Hyderabad to Goa departs ${new Date(now + 20 * HOUR).toISOString().slice(0, 16)}`,
      at: now - 4 * DAY,
    }),
    email({
      from: 'Expensify <concierge@expensify.com>',
      subject: 'Action required: expense report awaiting your approval',
      body: `Priya submitted "Offsite travel" (₹12,400). Please approve by ${new Date(now + 2 * DAY).toISOString().slice(0, 10)}.`,
      at: now - 5 * HOUR,
    }),
    email({ from: 'Myntra <news@myntra.com>', subject: 'Big Fashion Sale: 70% off', body: 'Shop now', at: now - DAY }),
  ];
  const sent = [
    email({
      from: 'Sam Lee <sam@example.com>',
      to: 'pranathi@gradsiren.com',
      subject: 'Application for Software Developer Role | Sam Lee',
      body: 'Hi, I would like to apply.',
      at: now - 5 * DAY,
    }),
  ];
  return { inbox, sent };
}

export function startMockMail(port: number): Promise<{ close: () => void; append: (m: ReturnType<typeof email>) => void }> {
  const { inbox, sent } = seedMail();
  const server = hoodiecrow({
    plugins: ['SPECIAL-USE'],
    users: { 'sam@example.com': { password: 'app-password' } },
    storage: { INBOX: { messages: inbox }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: sent } } } },
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () => server.close(),
        append: (m) => server.appendMessage('INBOX', m.flags, m.internaldate, m.raw),
      }),
    ),
  );
}
