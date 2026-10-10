import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai';
import { all, get, id, insert, now, parseJSON, run } from './db.ts';
import { publish } from './bus.ts';
import { getModel, modelLabel, type FallbackNotice } from './llm.ts';
import { getKV, getSettings, setKV } from './settings.ts';
import { extractMemories, memoryContext } from './memory.ts';
import { projectContext } from './projects.ts';
import { buildTools } from './tools/index.ts';
import { tokenCatalog } from './vault.ts';
import { getWeather, weatherLine } from './weather.ts';
import { emailEnabled, googleConnected, listAccounts } from './connectors/email.ts';
import { calendarEnabled, canCreateEvents } from './connectors/calendar.ts';
import { filesEnabled } from './connectors/files.ts';
import { mcpToolSummary } from './connectors/mcp.ts';
import { UNTRUSTED_CONTENT_RULE } from './security.ts';
import { storeFile } from './documents.ts';

export interface ActiveRun {
  id: string;
  conversationId: string;
  controller: AbortController;
  text: string;
  tools: { id: string; name: string; input: unknown; output?: unknown; error?: string; handoffId?: string }[];
}

const active = new Map<string, ActiveRun>();

export const activeRunFor = (conversationId: string) => [...active.values()].find((r) => r.conversationId === conversationId);

export function listConversations(projectId?: string) {
  return projectId
    ? all('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC', projectId)
    : all('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200');
}

/** The single main thread, like a messaging app. Briefs, routines and card actions land here. */
export function mainConversationId(): string {
  const existing = getKV('main.conversation');
  if (existing && get('SELECT 1 AS x FROM conversations WHERE id = ?', existing)) return existing;
  const cid = createConversation(null, 'Errand');
  setKV('main.conversation', cid);
  return cid;
}

export function createConversation(projectId?: string | null, title = 'New chat') {
  const cid = id();
  insert('conversations', { id: cid, title, project_id: projectId ?? null, created_at: now(), updated_at: now() });
  publish({ type: 'conversations.updated' });
  return cid;
}

export function getConversation(cid: string) {
  const c = get('SELECT * FROM conversations WHERE id = ?', cid);
  if (!c) return undefined;
  const messages = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', cid).map((m) => ({
    id: m.id,
    role: m.role,
    content: parseJSON(m.content, []),
    kind: m.kind,
    created_at: m.created_at,
  }));
  const r = activeRunFor(cid);
  return { ...c, messages, activeRun: r ? { id: r.id, text: r.text, tools: r.tools } : null };
}

export function deleteConversation(cid: string) {
  activeRunFor(cid)?.controller.abort();
  run('DELETE FROM conversations WHERE id = ?', cid);
  publish({ type: 'conversations.updated' });
}

export function renameConversation(cid: string, title: string) {
  run('UPDATE conversations SET title = ? WHERE id = ?', title, cid);
  publish({ type: 'conversations.updated' });
}

export function moveConversation(cid: string, projectId: string | null) {
  run('UPDATE conversations SET project_id = ? WHERE id = ?', projectId, cid);
  publish({ type: 'conversations.updated' });
}

/** kind: 'normal' for chat, 'update' for background task results, 'routine' for scheduled runs. */
export type MessageKind = 'normal' | 'update' | 'routine' | 'event';

function saveMessage(cid: string, msg: ModelMessage, kind: MessageKind = 'normal') {
  insert('messages', { id: id(), conversation_id: cid, role: msg.role, content: JSON.stringify(msg.content), kind, created_at: now() });
}

function history(cid: string): ModelMessage[] {
  // 'event' rows ("✓ code submitted") are for the timeline only; the model never sees them.
  const rows = all<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE conversation_id = ? AND kind != 'event' ORDER BY created_at, rowid",
    cid,
  );
  const msgs = rows.map((r) => ({ role: r.role, content: parseJSON(r.content, []) }) as ModelMessage);
  // Keep the last ~60 messages, cutting only at a user turn so tool calls stay paired with results.
  if (msgs.length <= 60) return msgs;
  let start = msgs.length - 60;
  while (start < msgs.length && msgs[start].role !== 'user') start++;
  return msgs.slice(start);
}

async function systemPrompt(projectId: string | null, query: string) {
  const s = getSettings();
  const w = await getWeather();
  const connected = [
    emailEnabled() &&
      `email: ${listAccounts()
        .map((a) => a.address)
        .join(', ')} (search, read, file into folders/labels, send with approval)`,
    calendarEnabled() && `calendar${canCreateEvents() ? ' (read + create events)' : ' (read)'}`,
    googleConnected() && 'Google Drive (search, read)',
    filesEnabled() && `files in ${s.files.roots.join(', ')}`,
    `MCP integrations: ${mcpToolSummary()}`,
  ].filter(Boolean);
  return `You are Errand, ${s.userName ? `${s.userName}'s` : 'the user’s'} personal AI assistant. You don't just answer: you get things done.

Now: ${new Date().toLocaleString('en-US', { timeZone: s.timezone, dateStyle: 'full', timeStyle: 'short' })} (${s.timezone}).
${s.location ? `Location: ${s.location.name}. ${weatherLine(w)}` : ''}

How to work:
- Be warm, brief and concrete. Lead with the outcome. Use markdown sparingly.
- Use what you remember about the user so they never have to repeat themselves. Save new durable facts with memory_save.
- Assume the user wants it done, not explained. Do the work, fill gaps from memory and context, and only ask when a choice truly matters (budget, which option).
- For anything that requires operating a website (ordering, booking, applying, paying bills, forms, renewals, cancellations, logged-in research), use handoff with a complete goal that includes the user's preferences and constraints. Use fetch_url / web_search for simple read-only lookups.
- When one message contains several independent tasks, start each as its own handoff with background=true so they run in parallel, then tell the user what is underway. Results arrive as [Task update] messages.
- Think ahead like a great assistant: after finishing something, offer the natural next step (add it to the calendar, reserve parking, set a reminder, track the delivery) or pin it as an action button.
- Pace follow-ups: when a step belongs later (send the ticket QR code an hour before the show, check the delivery on arrival day, chase a reply in three days), schedule it with routine_create (kind once) instead of piling everything into this reply.
- Show structured results (options, statuses, comparisons) as a markdown table under a short ### heading. Before sending an email, show the draft; the send tool asks for approval.
- When numbers are easier to see than read (a trend over time, a comparison of amounts), add a small chart: a fenced code block with the language chart containing JSON like {"type":"bar","title":"Spending by month","unit":"$","labels":["Jul","Aug"],"series":[{"name":"Food","values":[120,98]}]} (type bar or line, up to 4 series). Put a one-line takeaway above it.
- Anything irreversible (sending, paying, booking, deleting) needs the user's approval; the tools ask for it, so don't ask twice in chat.
- For multi-step goals that span days (job search, trip, move), create a project with tasks and keep its notes updated.
- When something should be done later or needs the user's sign-off, pin it as an action button.
- For recurring needs ("every morning", "keep my inbox tidy", "watch for new roles"), create a routine.
- When the user teaches you their way of doing a multi-step task, or corrects how you did one, save it with specialty_save. Follow any [specialty] in memory whenever it applies, without being reminded.
- The user can run everything from chat: changing preferences, switching AI models (model_choose), connecting accounts, adding calendars or integrations, changing or removing panels (panel_list, panel_update) and pausing or editing routines (routine_list, routine_update). Use connect_account to show a button for anything that needs a sign-in or a secret.
- Messages marked [Task update] or [Scheduled routine] are automatic, not typed by the user: report the outcome briefly and continue any follow-up work.
- Never ask for or repeat passwords or card numbers in chat. The vault handles them.
- ${UNTRUSTED_CONTENT_RULE}

Connected: ${connected.join('; ')}.

Vault (labels only):
${tokenCatalog()}

What you remember about the user:
${memoryContext(query)}
${s.customInstructions ? `\nUser's custom instructions:\n${s.customInstructions}` : ''}
${projectId ? `\n${projectContext(projectId)}` : ''}`;
}

export interface Attachment {
  name: string;
  mediaType: string;
  data: string; // base64
}

export async function sendMessage(cid: string, text: string, attachments: Attachment[] = [], kind: MessageKind = 'normal'): Promise<string> {
  const conv = get<{ id: string; project_id: string | null; title: string }>('SELECT * FROM conversations WHERE id = ?', cid);
  if (!conv) throw new Error('Conversation not found');
  if (activeRunFor(cid)) throw new Error('Still working on the previous message');

  const content: any[] = [];
  for (const a of attachments) {
    if (a.mediaType.startsWith('text/') || /json|xml|csv/.test(a.mediaType))
      content.push({ type: 'text', text: `Attached file ${a.name}:\n${Buffer.from(a.data, 'base64').toString('utf8').slice(0, 50000)}` });
    else content.push({ type: 'file', data: a.data, mediaType: a.mediaType, filename: a.name });
    // Kept as a file too, so the browser agent can upload it (a CV for an application, say).
    if (!a.mediaType.startsWith('text/')) storeFile(a.name, Buffer.from(a.data, 'base64'));
  }
  if (text) content.push({ type: 'text', text });
  saveMessage(cid, { role: 'user', content }, kind);
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), cid);

  const r: ActiveRun = { id: id(), conversationId: cid, controller: new AbortController(), text: '', tools: [] };
  active.set(r.id, r);
  publish({ type: 'run.start', runId: r.id, conversationId: cid });
  void execute(r, conv, text);
  return r.id;
}

/** Run the last user message again (after switching models, say), replacing the failed reply. */
export function retryLast(cid: string): string {
  const conv = get<{ id: string; project_id: string | null; title: string }>('SELECT * FROM conversations WHERE id = ?', cid);
  if (!conv) throw new Error('Conversation not found');
  if (activeRunFor(cid)) throw new Error('Still working on the previous message');
  const last = get<{ id: string; role: string; content: string }>(
    "SELECT id, role, content FROM messages WHERE conversation_id = ? AND kind != 'event' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    cid,
  );
  if (last?.role === 'assistant' && last.content.includes('⚠️')) run('DELETE FROM messages WHERE id = ?', last.id);
  const user = get<{ content: string }>(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    cid,
  );
  if (!user) throw new Error('Nothing to retry');
  const text = parseJSON<{ type: string; text?: string }[]>(user.content, [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const r: ActiveRun = { id: id(), conversationId: cid, controller: new AbortController(), text: '', tools: [] };
  active.set(r.id, r);
  publish({ type: 'run.start', runId: r.id, conversationId: cid });
  publish({ type: 'conversations.updated' });
  void execute(r, conv, text);
  return r.id;
}

async function execute(r: ActiveRun, conv: { id: string; project_id: string | null; title: string }, userText: string) {
  const cid = conv.id;
  const emit = (e: Record<string, unknown>) => publish({ ...e, type: e.type as string, runId: r.id, conversationId: cid });
  let finalText = '';
  let switched = false;
  // Noted once, when the model actually fails; while it cools down, replies just come from the other one.
  const onFallback: FallbackNotice = (from, to, err) => {
    if (switched || !err) return;
    switched = true;
    const reason = failureReason(err);
    // A quota or a rejected key won't fix itself in minutes, so say how to switch for good.
    const tip = /limit|key/.test(reason) ? `. Say "use ${modelLabel(to).split(' · ')[0]}" to switch for good` : '';
    recordEvent(cid, `${modelLabel(from)} ${reason}, so ${modelLabel(to)} answered${tip}`, 'cpu');
  };
  try {
    const result = streamText({
      model: getModel('chat', onFallback),
      system: await systemPrompt(conv.project_id, userText),
      messages: history(cid),
      tools: buildTools({
        conversationId: cid,
        projectId: conv.project_id,
        signal: r.controller.signal,
        onHandoff: (hid) => {
          const t = r.tools.findLast((x) => x.name === 'handoff' && !x.handoffId);
          if (t) t.handoffId = hid;
          emit({ type: 'run.handoff', handoffId: hid, toolCallId: t?.id });
        },
      }),
      stopWhen: stepCountIs(25),
      abortSignal: r.controller.signal,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          r.text += part.text;
          finalText += part.text;
          emit({ type: 'run.text', delta: part.text });
          break;
        case 'tool-call':
          r.tools.push({ id: part.toolCallId, name: part.toolName, input: part.input });
          emit({ type: 'run.tool-call', toolCallId: part.toolCallId, name: part.toolName, input: part.input });
          break;
        case 'tool-result': {
          const t = r.tools.find((x) => x.id === part.toolCallId);
          if (t) t.output = part.output;
          emit({ type: 'run.tool-result', toolCallId: part.toolCallId, output: truncate(part.output) });
          break;
        }
        case 'tool-error': {
          const t = r.tools.find((x) => x.id === part.toolCallId);
          const msg = String((part as any).error?.message ?? (part as any).error);
          if (t) t.error = msg;
          emit({ type: 'run.tool-error', toolCallId: part.toolCallId, error: msg });
          break;
        }
        case 'finish-step':
          // Separate text from consecutive steps.
          if (r.text && !r.text.endsWith('\n')) r.text += '\n\n';
          break;
        case 'error':
          throw (part as any).error;
      }
    }
    for (const m of await result.responseMessages) saveMessage(cid, m as ModelMessage);
  } catch (err) {
    const aborted = r.controller.signal.aborted;
    const msg = aborted ? 'Stopped.' : friendlyError(err);
    if (!aborted) console.error('[chat]', err);
    saveMessage(cid, { role: 'assistant', content: [{ type: 'text', text: `${r.text ? r.text + '\n\n' : ''}${aborted ? '_Stopped._' : `⚠️ ${msg}`}` }] });
    emit({ type: 'run.error', error: msg });
  } finally {
    active.delete(r.id);
    run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), cid);
    emit({ type: 'run.end' });
    publish({ type: 'conversations.updated' });
  }

  if (conv.title === 'New chat') void autoTitle(cid, userText);
  if (finalText) extractMemories(userText, finalText).catch((e) => console.warn('[memory]', e.message));
}

/** Record a timeline event such as "Cazvid code submitted". */
export function recordEvent(cid: string, text: string, icon = 'check') {
  if (!get('SELECT 1 AS x FROM conversations WHERE id = ?', cid)) return;
  // Events never reach the model, so the extra icon field is safe here.
  saveMessage(cid, { role: 'assistant', content: [{ type: 'text', text, icon } as { type: 'text'; text: string }] }, 'event');
  publish({ type: 'conversations.updated' });
}

/** Add an assistant message without a model run (briefs, system notices). */
export function postAssistantMessage(cid: string, text: string) {
  saveMessage(cid, { role: 'assistant', content: [{ type: 'text', text }] });
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), cid);
  publish({ type: 'conversations.updated' });
}

/**
 * Post an automatic update (e.g. a background browser task finished) and let the assistant react.
 * Waits for any run in progress on that conversation to finish first.
 */
export async function postUpdate(cid: string, text: string) {
  for (let i = 0; i < 600 && activeRunFor(cid); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!get('SELECT 1 AS x FROM conversations WHERE id = ?', cid)) return;
  await sendMessage(cid, `[Task update] ${text}`, [], 'update').catch((e) => console.warn('[chat] update failed:', e.message));
}

export function stopRun(runId: string) {
  active.get(runId)?.controller.abort();
}

async function autoTitle(cid: string, text: string) {
  try {
    const { text: title } = await generateText({
      model: getModel('utility'),
      prompt: `Write a 2-5 word title for a conversation that starts with this message. Reply with the title only, no quotes.\n\n${text.slice(0, 1000)}`,
    });
    renameConversation(cid, title.replace(/["*#]/g, '').trim().slice(0, 60) || 'Chat');
  } catch {
    renameConversation(cid, text.slice(0, 40) || 'Chat');
  }
}

function truncate(v: unknown) {
  const s = JSON.stringify(v ?? null);
  return s.length > 4000 ? JSON.parse(JSON.stringify({ preview: s.slice(0, 4000) + '…' })) : v;
}

/** A few words on why a model failed, for the "answered instead" note. */
function failureReason(err: unknown) {
  const e = (err as any)?.lastError ?? err;
  const msg = String(e?.message ?? err);
  if (e?.statusCode === 503 || /high demand|overloaded|unavailable|capacity/i.test(msg)) return 'was busy';
  if (e?.statusCode === 429 || /429|rate.?limit|quota|usage_limit/i.test(msg)) return 'hit its limit';
  if (e?.statusCode === 401 || e?.statusCode === 403 || /invalid.*api.?key|unauthorized/i.test(msg)) return 'rejected its key';
  if (/ECONNREFUSED|Cannot connect to API|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(msg)) return 'could not be reached';
  return 'failed';
}

function friendlyError(err: unknown): string {
  // Retries wrap the real error ("Failed after 3 attempts. Last error: …"); report the real one.
  const e = (err as any)?.lastError ?? err;
  const msg = String(e?.message ?? err);
  if (e?.statusCode === 503 || /high demand|overloaded|unavailable|capacity/i.test(msg))
    return 'This model is busy right now (high demand on the provider’s side). Switch to another model below, or try again in a minute.';
  if (e?.statusCode === 401 || /401|invalid.*api.?key|unauthorized/i.test(msg)) return 'The API key was rejected. Check it in Settings → Models.';
  if (/subscription_sharing_usage_limit_exceeded/.test(msg))
    return 'You have used up the ChatGPT plan allowance Errand may use. It resets with your plan, or adjust the limit in ChatGPT settings.';
  if (/subscription_sharing_usage_unavailable/.test(msg))
    return 'ChatGPT plan usage is not available for this account right now. Try again later or add an API key.';
  if (e?.statusCode === 429 || /429|rate.?limit|quota/i.test(msg))
    return 'The model provider is rate-limiting or out of quota. Try again shortly or switch models.';
  if (/ECONNREFUSED/.test(msg)) return 'Could not reach the model server. Is it running (e.g. Ollama)?';
  if (/Cannot connect to API|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(msg))
    return 'Could not reach this model. Check your internet connection, then try again or switch models below.';
  return msg.slice(0, 500);
}
