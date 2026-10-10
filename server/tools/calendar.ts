import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { buildICS, calendarEnabled, canCreateEvents, createEvent, listEvents } from '../connectors/calendar.ts';
import { emailEnabled, googleConnected, googleToken, sendEmail } from '../connectors/email.ts';
import { driveRead, driveSearch } from '../connectors/google.ts';
import { requestApproval } from '../approvals.ts';
import type { ToolContext } from './index.ts';

/** Calendar (Google + iCal feeds) and Google Drive. */
export function calendarTools(ctx: ToolContext) {
  const tools: ToolSet = {};

  if (calendarEnabled()) {
    tools.calendar_events = tool({
      description: 'List calendar events in a time range (ISO dates). Defaults to the next 7 days.',
      inputSchema: z.object({ from: z.string().optional(), to: z.string().optional() }),
      execute: async ({ from, to }) => listEvents(from, to),
    });
  }

  if (canCreateEvents()) {
    tools.calendar_create_event = tool({
      description: 'Add an event to the user’s Google Calendar (asks first). Optionally invite attendees.',
      inputSchema: z.object({
        title: z.string(),
        start: z.string().describe('ISO date-time with offset'),
        end: z.string(),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        account: z.string().optional(),
      }),
      execute: async (e) => {
        const ok = await requestApproval(
          {
            title: 'Add to your calendar?',
            detail: `${e.title}\n${new Date(e.start).toLocaleString()} → ${new Date(e.end).toLocaleString()}${e.location ? `\n${e.location}` : ''}${e.attendees?.length ? `\nInvites: ${e.attendees.join(', ')}` : ''}`,
            conversationId: ctx.conversationId,
          },
          ctx.signal,
        );
        return ok ? createEvent(e) : { created: false };
      },
    });
  } else {
    tools.calendar_invite = tool({
      description: 'Create a calendar invite (.ics). If email is connected it can be emailed to the user so it lands in any calendar.',
      inputSchema: z.object({
        title: z.string(),
        start: z.string(),
        end: z.string(),
        location: z.string().optional(),
        description: z.string().optional(),
        email_to: z.string().optional(),
      }),
      execute: async (i) => {
        const ics = buildICS(i);
        if (!i.email_to || !emailEnabled()) return { ics };
        const ok = await requestApproval(
          { title: 'Email this calendar invite?', detail: `${i.title}\n${i.start} → ${i.end}\nTo: ${i.email_to}`, conversationId: ctx.conversationId },
          ctx.signal,
        );
        if (!ok) return { sent: false };
        await sendEmail({
          to: i.email_to,
          subject: `Invitation: ${i.title}`,
          body: `${i.title}\n${i.start} – ${i.end}\n${i.location ?? ''}`,
          attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=PUBLISH' }],
        });
        return { sent: true };
      },
    });
  }

  if (googleConnected()) {
    tools.drive_search = tool({
      description: 'Search Google Drive (docs, sheets, PDFs) by content.',
      inputSchema: z.object({ query: z.string(), account: z.string().optional() }),
      execute: async ({ query, account }) => {
        const { address, token } = await googleToken(account);
        return { account: address, files: await driveSearch(token, query) };
      },
    });
    tools.drive_read = tool({
      description: 'Read a Google Drive file as text by id.',
      inputSchema: z.object({ id: z.string(), account: z.string().optional() }),
      execute: async ({ id, account }) => driveRead((await googleToken(account)).token, id),
    });
  }
  return tools;
}
