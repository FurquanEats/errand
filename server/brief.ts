import { z } from 'zod';
import { generateJSON, hasModel } from './llm.ts';
import { addMemory, listMemories, CATEGORIES } from './memory.ts';
import { createAction } from './actions.ts';
import { mainConversationId, postAssistantMessage } from './chat.ts';
import { getSettings } from './settings.ts';
import { notify } from './notify.ts';
import { emailEnabled, googleConnected, googleToken, searchEmail } from './connectors/email.ts';
import { senderOverview } from './connectors/inbox.ts';
import { calendarEnabled, listEvents } from './connectors/calendar.ts';
import { driveRecent } from './connectors/google.ts';
import { listProjects } from './projects.ts';

/**
 * The "deep dive": when an inbox, calendar or Drive is connected, Errand catches up on your life,
 * learns durable facts (family birthdays, your work, recurring senders) and posts a Brief with
 * concrete offers, which are also pinned to the Home screen.
 */

const result = z.object({
  memories: z.array(z.object({ content: z.string(), category: z.string() })).default([]),
  intro: z.string(),
  offers: z
    .array(z.object({ title: z.string(), description: z.string().default(''), question: z.string(), prompt: z.string(), icon: z.string().default('✨') }))
    .max(6)
    .default([]),
});

let running = false;

export async function runBrief(reason: string, focusAccount?: string): Promise<string | null> {
  if (running || !hasModel()) return null;
  running = true;
  try {
    const s = getSettings();
    const parts: string[] = [];
    if (emailEnabled()) {
      const mail = await searchEmail({ sinceDays: 60, limit: 200, account: focusAccount }).catch(() => []);
      parts.push(`Recent email (${mail.length}):\n${mail.map((m) => `- ${m.date.slice(0, 10)} (${m.account}) ${m.from}: ${m.subject}`).join('\n')}`);
      const senders = await senderOverview({ account: focusAccount, sinceDays: 60, max: 1500 }).catch(() => null);
      if (senders)
        parts.push(
          `Most frequent senders:\n${senders.senders
            .slice(0, 20)
            .map((x) => `- ${x.sender} (${x.count} emails, ${x.unread} unread${x.unsubscribe ? ', mailing list' : ''})`)
            .join('\n')}`,
        );
    }
    if (calendarEnabled()) {
      const events = await listEvents(undefined, new Date(Date.now() + 45 * 86400_000).toISOString()).catch(() => []);
      parts.push(
        `Upcoming calendar (45 days):\n${
          events
            .slice(0, 80)
            .map((e) => `- ${e.start.slice(0, 16)} ${e.title}`)
            .join('\n') || '(empty)'
        }`,
      );
    }
    if (googleConnected()) {
      const files = await googleToken(focusAccount?.includes('@') ? focusAccount : undefined)
        .then(({ token }) => driveRecent(token))
        .catch(() => []);
      if (files.length) parts.push(`Recent Drive files:\n${files.map((f: any) => `- ${f.name} (${f.mimeType})`).join('\n')}`);
    }
    const projects = listProjects();
    if (projects.length) parts.push(`Projects: ${projects.map((p) => p.name).join(', ')}`);
    if (!parts.length) return null;

    const known = listMemories();
    const out = await generateJSON({
      role: 'chat',
      system:
        `You are Errand, a proactive personal assistant for ${s.userName || 'the user'}. You just got access to their ${focusAccount ?? 'accounts'} (${reason}). ` +
        'Read the material and (1) extract durable facts worth remembering: family members and birthdays, where they work and what they build, services and subscriptions they use, travel, recurring obligations; ' +
        '(2) write a warm one-line intro; (3) propose up to 4 concrete things you can take care of now, each grounded in what you saw. ' +
        'For each offer: "question" is how you ask it in chat ("Want me to file them under their own label?"), "title" starts with a verb ("File Wheelness alerts under a label"), and "prompt" is the full instruction to run. ' +
        `Memory categories: ${CATEGORIES.join(', ')}. Do not repeat known facts. Never include passwords, codes or card numbers.`,
      prompt: `Already known:\n${known.map((m) => `- ${m.content}`).join('\n') || '(nothing)'}\n\n${parts.join('\n\n')}`,
      schema: result,
      example:
        '{"memories":[{"content":"Dad’s birthday is November 12","category":"people"}],"intro":"Now that your inbox is connected, here are a few things I can take care of.","offers":[{"title":"Find a birthday gift for Dad","description":"Nov 12","question":"Your dad’s birthday is coming up. Want me to find a few gift ideas that arrive in time?","prompt":"Find 5 birthday gift ideas for my dad that can arrive before November 12","icon":"🎁"}]}',
    });

    const knownText = known.map((m) => m.content.toLowerCase());
    for (const m of out.memories) {
      if (!m.content.trim() || knownText.some((k) => k.includes(m.content.toLowerCase()) || m.content.toLowerCase().includes(k))) continue;
      addMemory(m.content, CATEGORIES.includes(m.category) ? m.category : 'general', 'brief');
    }
    for (const o of out.offers) createAction({ title: o.title, description: o.description, prompt: o.prompt, icon: o.icon, priority: 2, source: 'brief' });

    const h = new Date().getHours();
    const title = `${h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'} Brief`;
    const body = [
      `### ${title}`,
      '',
      out.intro,
      '',
      ...out.offers.map((o) => `- ${o.question}`),
      '',
      out.offers.length ? 'These are saved on your Home screen. Want to start one now?' : '',
    ].join('\n');
    const cid = mainConversationId();
    postAssistantMessage(cid, body);
    void notify({ title: `${title} is ready`, body: 'Errand caught up on your accounts.', url: `/#/c/${cid}` });
    return cid;
  } catch (err) {
    console.warn('[brief]', (err as Error).message);
    return null;
  } finally {
    running = false;
  }
}
