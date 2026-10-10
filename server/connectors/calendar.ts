import ical, { type VEvent } from 'node-ical';
import { getSettings } from '../settings.ts';
import { all } from '../db.ts';
import { unseal } from '../crypto.ts';
import { accessToken, calendarEvents, createCalendarEvent } from './google.ts';

/**
 * Reads any calendar that can publish an iCal feed: Google ("Secret address in iCal format"),
 * Outlook ("Publish calendar" → ICS), iCloud (public calendar link), Fastmail, Proton, etc.
 */

export interface CalEvent {
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
}

const cache = new Map<string, { at: number; data: Awaited<ReturnType<typeof ical.async.fromURL>> }>();

async function load(url: string) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = ical.sync.parseICS(await res.text());
  cache.set(url, { at: Date.now(), data });
  return data;
}

const str = (v: any): string => (v == null ? '' : typeof v === 'string' ? v : String(v.val ?? v));

const googleAccounts = () => all<{ address: string; secret: string }>("SELECT address, secret FROM email_accounts WHERE kind = 'google' ORDER BY created_at");

export const calendarEnabled = () => getSettings().calendars.length > 0 || googleAccounts().length > 0;
export const canCreateEvents = () => googleAccounts().length > 0;

/** Create an event in a connected Google account's primary calendar. */
export async function createEvent(e: {
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  account?: string;
}) {
  const accounts = googleAccounts();
  const acc = (e.account && accounts.find((a) => a.address.toLowerCase() === e.account!.toLowerCase())) || accounts[0];
  if (!acc) throw new Error('Connect a Google account to create calendar events.');
  return { account: acc.address, ...(await createCalendarEvent(await accessToken(acc.address, unseal(acc.secret)), e)) };
}

export async function listEvents(fromISO?: string, toISO?: string): Promise<CalEvent[]> {
  const from = fromISO ? new Date(fromISO) : new Date();
  const to = toISO ? new Date(toISO) : new Date(Date.now() + 7 * 86400_000);
  const out: CalEvent[] = [];
  for (const cal of getSettings().calendars) {
    try {
      const data = await load(cal.url);
      for (const comp of Object.values(data)) {
        if (!comp || (comp as any).type !== 'VEVENT') continue;
        const ev = comp as VEvent;
        for (const inst of ical.expandRecurringEvent(ev, { from, to, expandOngoing: true })) {
          out.push({
            calendar: cal.name,
            title: str(inst.summary),
            start: new Date(inst.start).toISOString(),
            end: new Date(inst.end).toISOString(),
            allDay: inst.isFullDay,
            location: str(inst.event.location),
            description: str(inst.event.description).slice(0, 500),
          });
        }
      }
    } catch (err) {
      out.push({
        calendar: cal.name,
        title: `⚠ Could not load calendar: ${(err as Error).message}`,
        start: from.toISOString(),
        end: from.toISOString(),
        allDay: true,
        location: '',
        description: '',
      });
    }
  }
  for (const acc of googleAccounts()) {
    try {
      const events = await calendarEvents(await accessToken(acc.address, unseal(acc.secret)), from, to);
      out.push(
        ...events.map((e) => ({
          ...e,
          calendar: `${e.calendar} (${acc.address})`,
          start: new Date(e.start).toISOString(),
          end: new Date(e.end).toISOString(),
        })),
      );
    } catch (err) {
      out.push({
        calendar: acc.address,
        title: `⚠ ${(err as Error).message}`,
        start: from.toISOString(),
        end: from.toISOString(),
        allDay: true,
        location: '',
        description: '',
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Build an .ics invite so events can be added to any calendar (attach it to an email, or download it). */
export function buildICS(e: { title: string; start: string; end: string; location?: string; description?: string }) {
  const fmt = (d: string) =>
    new Date(d)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const esc = (s = '') => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Errand//EN',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@errand`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(e.start)}`,
    `DTEND:${fmt(e.end)}`,
    `SUMMARY:${esc(e.title)}`,
    e.location ? `LOCATION:${esc(e.location)}` : '',
    e.description ? `DESCRIPTION:${esc(e.description)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}
