import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, navigate, takeDraft, useEvents, useResource } from '../api';
import { useApp } from '../context';

const STARTERS = [
  'What needs my attention today?',
  'Find the cheapest flight to Goa next Friday',
  'Keep track of my job applications',
  'Brief me every morning at 8',
  'Put Errand on my phone',
];
import { speak, startListening, stopSpeaking, type Listening } from '../voice';
import { Composer, type Attachment } from './Composer';
import { Markdown } from './Markdown';
import { ToolCard, unwrapOutput } from './ToolCard';
import { InlinePending } from './Pending';
import { Icon } from './Icon';

// Settings is big and only needed when adding a model, so it loads on demand.
const ModelSettings = lazy(() => import('./Settings').then((m) => ({ default: m.ModelSettings })));

interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: any;
  kind?: 'normal' | 'update' | 'routine' | 'event';
  created_at?: number;
}

interface LiveTool {
  id: string;
  name: string;
  input: any;
  output?: any;
  error?: string;
  handoffId?: string;
}

interface Conversation {
  id: string;
  title: string;
  project_id: string | null;
  messages: Msg[];
  activeRun: { id: string; text: string; tools: LiveTool[] } | null;
}

type Item = { kind: 'text'; text: string } | { kind: 'tool'; id: string; name: string; input: any; output?: any; error?: string };
type Turn =
  | { role: 'user'; content: any[]; id: string }
  | { role: 'event'; text: string; icon: string; id: string; done?: boolean }
  | { role: 'assistant'; items: Item[]; id: string; at?: number };

const textOf = (content: any) => (Array.isArray(content) ? content.map((p: any) => p.text ?? '').join(' ') : String(content));

/** Group stored model messages into display turns, pairing tool calls with their results. */
function toTurns(messages: Msg[]): Turn[] {
  const turns: Turn[] = [];
  const results = new Map<string, any>();
  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.content)) for (const p of m.content) if (p.type === 'tool-result') results.set(p.toolCallId, p.output);
  }
  for (const m of messages) {
    if (m.kind === 'event') {
      turns.push({ role: 'event', icon: (Array.isArray(m.content) && m.content[0]?.icon) || 'check', text: textOf(m.content), id: m.id, done: true });
    } else if (m.role === 'user' && m.kind === 'update') {
      turns.push({
        role: 'event',
        icon: 'globe',
        text: textOf(m.content)
          .replace(/^\[Task update\]\s*/, '')
          .split('\n')[0],
        id: m.id,
      });
    } else if (m.role === 'user' && m.kind === 'routine') {
      turns.push({ role: 'event', icon: 'clock', text: textOf(m.content).match(/“(.+?)”/)?.[1] ?? 'Scheduled routine', id: m.id });
    } else if (m.role === 'user') {
      turns.push({ role: 'user', content: Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }], id: m.id });
    } else if (m.role === 'assistant') {
      let last = turns.at(-1);
      if (!last || last.role !== 'assistant') {
        last = { role: 'assistant', items: [], id: m.id, at: m.created_at };
        turns.push(last);
      }
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      for (const p of parts) {
        if (p.type === 'text' && p.text.trim()) last.items.push({ kind: 'text', text: p.text });
        if (p.type === 'tool-call') {
          const out = results.get(p.toolCallId);
          const isErr = out?.type === 'error-text' || out?.type === 'error-json';
          last.items.push({
            kind: 'tool',
            id: p.toolCallId,
            name: p.toolName,
            input: p.input,
            output: isErr ? undefined : out,
            error: isErr ? String(unwrapOutput(out)) : undefined,
          });
        }
      }
    }
  }
  return turns;
}

/** "Errand · 9:12 am" above a reply, when time has passed since the last one shown. */
function stamp(t: Turn, turns: Turn[]) {
  if (t.role !== 'assistant' || !t.at) return '';
  const prev = turns
    .slice(0, turns.indexOf(t))
    .reverse()
    .find((x): x is Extract<Turn, { role: 'assistant' }> => x.role === 'assistant' && !!x.at);
  if (prev?.at && t.at - prev.at < 20 * 60_000) return '';
  const d = new Date(t.at);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Errand · ${today ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`}`;
}

function UserBubble({ content }: { content: any[] }) {
  return (
    <div className="msg-user">
      {content.map((p, i) =>
        p.type === 'image' || (p.type === 'file' && /^image\//.test(p.mediaType ?? '')) ? (
          <img key={i} src={`data:${p.mediaType ?? 'image/png'};base64,${p.image ?? p.data}`} alt="" />
        ) : p.type === 'file' ? (
          <span key={i} className="file">
            <Icon name="clip" size={13} /> {p.filename}
          </span>
        ) : p.text?.startsWith('Attached file ') ? (
          <span key={i} className="file">
            <Icon name="clip" size={13} /> {p.text.slice(14, p.text.indexOf(':'))}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}

/** The single main thread, like a messaging app. */
export function MainChat() {
  const { data } = useResource<{ id: string }>('/conversations/main', []);
  return data ? (
    <Chat key={data.id} id={data.id} main />
  ) : (
    <div className="empty">
      <span className="spinner" />
    </div>
  );
}

export function Chat({ id, main }: { id: string; main?: boolean }) {
  const { settings } = useApp();
  const { data: conv, reload } = useResource<Conversation>(`/conversations/${id}`, []);
  const [live, setLive] = useState<{ runId: string; text: string; tools: LiveTool[] } | null>(null);
  const [error, setError] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);
  const listening = useRef<Listening | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLive(conv?.activeRun ? { runId: conv.activeRun.id, text: conv.activeRun.text, tools: conv.activeRun.tools } : null);
  }, [conv]);

  const send = async (text: string, attachments: Attachment[] = []) => {
    setError('');
    stick.current = true;
    try {
      await api(`/conversations/${id}/messages`, { body: { text, attachments } });
      void reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  // Hands-free: listen, send, speak the reply, listen again.
  const listen = () => {
    listening.current?.stop();
    listening.current = startListening({
      onText: (t, final) => final && t.trim() && void send(t.trim()),
      onEnd: () => (listening.current = null),
      onError: (m) => (setError(m), setVoiceMode(false)),
    });
  };
  useEffect(() => {
    if (voiceMode && !live) listen();
    if (!voiceMode) {
      listening.current?.stop();
      stopSpeaking();
    }
    return () => listening.current?.stop();
  }, [voiceMode]);

  useEvents((e) => {
    if (e.type === 'conversations.updated' && !live) void reload();
    if (e.conversationId !== id) return;
    switch (e.type) {
      case 'run.start':
        setLive({ runId: e.runId, text: '', tools: [] });
        break;
      case 'run.text':
        setLive((l) => (l ? { ...l, text: l.text + e.delta } : l));
        break;
      case 'run.tool-call':
        setLive((l) => (l ? { ...l, tools: [...l.tools, { id: e.toolCallId, name: e.name, input: e.input }] } : l));
        break;
      case 'run.tool-result':
        setLive((l) => (l ? { ...l, tools: l.tools.map((t) => (t.id === e.toolCallId ? { ...t, output: e.output } : t)) } : l));
        break;
      case 'run.tool-error':
        setLive((l) => (l ? { ...l, tools: l.tools.map((t) => (t.id === e.toolCallId ? { ...t, error: e.error } : t)) } : l));
        break;
      case 'run.handoff':
        setLive((l) =>
          l ? { ...l, tools: l.tools.map((t) => (t.id === e.toolCallId || (!t.handoffId && t.name === 'handoff') ? { ...t, handoffId: e.handoffId } : t)) } : l,
        );
        break;
      case 'run.end':
        setLive((l) => {
          if (l?.text && (voiceMode || settings?.voice.speakReplies)) {
            speak(l.text);
            if (voiceMode) setTimeout(listen, Math.min(20000, 1500 + l.text.length * 55));
          }
          return null;
        });
        void reload();
        break;
    }
  });

  const turns = useMemo(() => toTurns(conv?.messages ?? []), [conv?.messages]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, live, error]);
  // Anything that grows the conversation (a request, a chart, an image) keeps you at the bottom.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    ro.observe(inner);
    return () => ro.disconnect();
  }, [!!conv]);

  if (!conv)
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );

  return (
    <div className="chat">
      {!main && (
        <div className="chat-head">
          <a className="back" href={conv.project_id ? `#/projects/${conv.project_id}` : '#/chat'} style={{ margin: 0 }}>
            <Icon name="chevronLeft" size={18} /> {conv.project_id ? 'Project' : 'Chat'}
          </a>
          <span className="title">{conv.title}</span>
          <button
            className="btn icon sm"
            title="Delete chat"
            onClick={async () => {
              if (!confirm('Delete this chat?')) return;
              await api(`/conversations/${id}`, { method: 'DELETE' });
              navigate(conv.project_id ? `/projects/${conv.project_id}` : '/chat');
            }}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      )}
      <div
        className="chat-scroll"
        tabIndex={0}
        aria-label="Conversation"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="messages">
          {!turns.length && !live && (
            <div className="chat-welcome rise">
              <h1>What can I take off your hands?</h1>
              <p>Ask in your own words. I use the web, your email and your calendar, and I ask before paying or sending anything.</p>
              <div className="chips">
                {STARTERS.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) =>
            t.role === 'user' ? (
              <UserBubble key={t.id} content={t.content} />
            ) : t.role === 'event' ? (
              t.done ? (
                <div key={t.id} className="ask-done">
                  <Icon name={t.icon} size={15} /> {t.text}
                </div>
              ) : (
                <div key={t.id} className="event-line">
                  <Icon name={t.icon} size={13} />
                  <span>{t.text}</span>
                </div>
              )
            ) : (
              <div key={t.id} className="msg-assistant rise">
                {stamp(t, turns) && <div className="msg-meta">{stamp(t, turns)}</div>}
                {t.items.map((it, i) =>
                  it.kind === 'text' ? (
                    <div key={i} className="msg-text">
                      <Markdown text={it.text} />
                    </div>
                  ) : (
                    <ToolCard key={it.id} name={it.name} input={it.input} output={it.output} error={it.error} />
                  ),
                )}
                {!live && t === turns[turns.length - 1] && t.items.some((it) => it.kind === 'text' && it.text.includes('⚠️')) && (
                  <ModelRescue conversationId={id} />
                )}
              </div>
            ),
          )}
          {live && !live.text && !live.tools.length && (
            // Like a read receipt: a quiet "Read" under your message while Errand thinks.
            <div className="read-status" role="status">
              <span className="read-dots" aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
              Read
            </div>
          )}
          {live && (live.text || live.tools.length > 0) && (
            <div className="msg-assistant">
              {live.tools.map((t) => (
                <ToolCard key={t.id} name={t.name} input={t.input} output={t.output} error={t.error} handoffId={t.handoffId} pending />
              ))}
              {live.text ? (
                <div className="msg-text">
                  <Markdown text={live.text} />
                </div>
              ) : (
                <span className="read-dots working" aria-label="Working">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          )}
          <InlinePending conversationId={id} />
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
      <div className="chat-foot">
        <div className="inner">
          <Composer
            onSend={send}
            busy={!!live}
            onStop={() => live && api(`/runs/${live.runId}/stop`, { body: {} })}
            autoFocus
            placeholder={main ? 'Message Errand' : 'Reply…'}
            initial={takeDraft()}
            voiceMode={voiceMode}
            onToggleVoice={() => setVoiceMode(!voiceMode)}
          />
        </div>
      </div>
    </div>
  );
}

/** Under a failed reply: switch to another model in one tap (or pick one) and run the message again. */
function ModelRescue({ conversationId }: { conversationId: string }) {
  const { settings, reloadSettings, toast } = useApp();
  const { data } = useResource<{ providers: { id: string; name: string; models: string[] }[] }>('/providers', ['settings.updated']);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const options = data?.providers.flatMap((p) => p.models.map((m) => ({ ref: `${p.id}:${m}`, label: `${p.name} · ${m}` }))) ?? [];

  /** Run a change, then the failed message again (unless the change returns false). */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      if ((await fn()) === false) return;
      await api(`/conversations/${conversationId}/retry`, { method: 'POST' });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const auto = () =>
    act(async () => {
      const r = await api<{ label: string }>('/models/auto', { body: {} }).catch((e) => {
        if (e instanceof ApiError && e.status === 400) return null;
        throw e;
      });
      // Nothing else to switch to: offer to add one right here.
      if (!r) return (setAdding(true), false);
      toast(`Switched to ${r.label}`);
      await reloadSettings();
    });
  const pick = (ref: string) =>
    act(async () => {
      await api('/settings', { method: 'PUT', body: { models: { ...settings!.models, chat: ref } } });
      await reloadSettings();
    });

  return (
    <div className="rescue">
      {options.length > 1 && (
        <button className="btn sm primary" disabled={busy} onClick={auto}>
          Switch automatically
        </button>
      )}
      {options.length > 0 && (
        <select className="select sm" disabled={busy} value={settings?.models.chat ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Chat model">
          {options.map((o) => (
            <option key={o.ref} value={o.ref}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <button className="btn sm" disabled={busy} onClick={() => act(async () => {})}>
        Try again
      </button>
      <button className="btn sm ghost" disabled={busy} onClick={() => setAdding(true)}>
        Add a model
      </button>
      {adding &&
        createPortal(
          <div className="overlay" onClick={(e) => e.target === e.currentTarget && setAdding(false)}>
            <div className="modal add-model" role="dialog" aria-modal="true" aria-labelledby="add-model-title">
              <h2 id="add-model-title">Add a model</h2>
              <p className="muted small">Sign in or paste a key. Errand switches to it and answers your message again.</p>
              <Suspense fallback={<span className="spinner" />}>
                <ModelSettings compact from={`retry:${conversationId}`} onAdded={(ref) => (setAdding(false), pick(ref))} />
              </Suspense>
              <div className="foot">
                <button className="btn" onClick={() => setAdding(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
