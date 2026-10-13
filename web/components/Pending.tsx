import { useState } from 'react';
import { api, useResource } from '../api';
import { useApp } from '../context';
import { TaskLine, showTask } from './HandoffView';
import { Icon } from './Icon';

export interface Pending {
  id: string;
  kind: 'approval' | 'question' | 'code' | 'unlock';
  title: string;
  detail: string;
  handoffId?: string;
  conversationId?: string;
}

export function usePending() {
  return useResource<Pending[]>('/pending', ['pending.created', 'pending.resolved']);
}

async function respond(p: Pending, approved: boolean, text = '') {
  // Unlock requests are answered by actually unlocking; the passphrase never goes to the agent.
  if (p.kind === 'unlock' && approved) await api('/vault/unlock', { body: { passphrase: text } });
  await api(`/pending/${p.id}`, { body: { approved, text: p.kind === 'unlock' ? '' : text } });
}

const KIND: Record<Pending['kind'], string> = {
  approval: 'Needs your OK',
  code: 'Verification code',
  unlock: 'Vault',
  question: 'Question',
};
const kindLabel = (p: Pending) => (p.kind === 'question' && p.handoffId ? 'The browser agent asks' : KIND[p.kind]);

/**
 * A request's words, laid out to be read at a glance: the question up top, and what it's based
 * on underneath, one fact per line. Older questions arrive as one long paragraph, so the
 * question is pulled off its end and the rest is broken into sentences.
 */
function shape(p: Pending) {
  let ask = p.title;
  let rest = p.detail.trim();
  if (p.kind === 'question' && rest && !rest.includes('\n')) {
    const sentences = rest
      .match(/[^.?!]+(?:[.?!]+(?=\s|$)|$)/g)
      ?.map((x) => x.trim())
      .filter(Boolean) ?? [rest];
    const q = sentences.findIndex((x, i) => x.endsWith('?') && sentences.slice(i).every((y) => y.endsWith('?')));
    if (q >= 0) {
      ask = sentences.slice(q).join(' ');
      rest = sentences.slice(0, q).join('\n');
    } else if (sentences.length > 2) rest = sentences.join('\n');
  }
  const lines = rest
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s+/, ''))
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^:]{2,28}):\s+(.+)$/);
      return m ? { label: m[1], text: m[2] } : { text: l };
    });
  return { ask, lines };
}

function RequestText({ p, title: Title = 'div' }: { p: Pending; title?: 'div' | 'h2' }) {
  const { ask, lines } = shape(p);
  return (
    <>
      <Title className="title">{ask}</Title>
      {lines.length > 0 && (
        <ul className="detail-lines">
          {lines.map((l, i) => (
            <li key={i}>
              {l.label && <span className="label">{l.label}</span>}
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const placeholderFor = (p: Pending) => (p.kind === 'code' ? '••••••' : p.kind === 'unlock' ? 'Vault passphrase' : 'Your answer');

/** One request, rendered for the chat it belongs to: a code pill, an approval card, or a question. */
function InlineRequest({ p, onDone }: { p: Pending; onDone: () => void }) {
  const [open, setOpen] = useState(p.kind !== 'code');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const [err, setErr] = useState('');
  const act = async (approved: boolean) => {
    setBusy(true);
    setErr('');
    try {
      await respond(p, approved, value);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (p.kind === 'code' && !open) {
    return (
      <button className="ask-pill" onClick={() => setOpen(true)}>
        <span className="key">
          <Icon name="key" size={14} />
        </span>
        {p.title}
      </button>
    );
  }

  return (
    <div className="ask-card rise" role="group" aria-label={p.title}>
      <div className="kind">{kindLabel(p)}</div>
      <RequestText p={p} />
      {p.kind === 'approval' ? (
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={() => act(true)}>
            Approve
          </button>
          <button className="btn" disabled={busy} onClick={() => act(false)}>
            Don’t do it
          </button>
          {p.handoffId && (
            <button className="btn ghost" onClick={() => showTask(p.handoffId!)}>
              <Icon name="eye" size={14} /> See the page
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), value.trim() && void act(true))}>
          <input
            className={`input ${p.kind === 'code' ? 'code-input' : ''}`}
            autoFocus
            type={p.kind === 'unlock' ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholderFor(p)}
            autoComplete={p.kind === 'code' ? 'one-time-code' : p.kind === 'unlock' ? 'current-password' : 'off'}
          />
          {err && (
            <div className="error-box" style={{ marginTop: 10 }}>
              {err}
            </div>
          )}
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy || !value.trim()}>
              {p.kind === 'unlock' ? 'Unlock' : 'Send'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => act(false)}>
              Skip
            </button>
            {p.handoffId && (
              <button type="button" className="btn ghost" onClick={() => showTask(p.handoffId!)}>
                <Icon name="eye" size={14} /> See the page
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** Requests that belong to this conversation, shown inline at the end of the chat. */
export function InlinePending({ conversationId }: { conversationId: string }) {
  const { data, setData } = usePending();
  const mine = (data ?? []).filter((p) => p.conversationId === conversationId);
  return (
    <>
      {mine.map((p) => (
        <InlineRequest key={p.id} p={p} onDone={() => setData((data ?? []).filter((x) => x.id !== p.id))} />
      ))}
    </>
  );
}

/** Requests from anywhere else (other chats, routines, browser tasks) appear as a sheet over the app. */
export function PendingTray({ route }: { route: string }) {
  const { toast } = useApp();
  const { data, setData } = usePending();
  const { data: main } = useResource<{ id: string }>('/conversations/main', []);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const here = route === '/chat' ? main?.id : route.startsWith('/c/') ? route.slice(3) : undefined;
  const p = (data ?? []).find((x) => !x.conversationId || x.conversationId !== here);
  if (!p) return null;

  const act = async (approved: boolean) => {
    setBusy(true);
    try {
      await respond(p, approved, answer);
      setData((data ?? []).filter((x) => x.id !== p.id));
      setAnswer('');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="badge">{kindLabel(p)}</div>
        <RequestText p={p} title="h2" />
        {p.handoffId && (
          <div style={{ margin: '12px 0' }}>
            <TaskLine id={p.handoffId} thumb />
          </div>
        )}
        {p.kind === 'approval' ? (
          <div className="foot">
            <button className="btn" disabled={busy} onClick={() => act(false)}>
              Don’t do it
            </button>
            <button className="btn primary" disabled={busy} onClick={() => act(true)} autoFocus>
              Approve
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => (e.preventDefault(), void act(true))}>
            <input
              className={`input ${p.kind === 'code' ? 'code-input' : ''}`}
              autoFocus
              type={p.kind === 'unlock' ? 'password' : 'text'}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              autoComplete={p.kind === 'code' ? 'one-time-code' : 'off'}
              placeholder={placeholderFor(p)}
            />
            <div className="foot" style={{ marginTop: 14 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => act(false)}>
                Skip
              </button>
              <button className="btn primary" disabled={busy || !answer.trim()}>
                Send
              </button>
            </div>
          </form>
        )}
        {(data?.length ?? 0) > 1 && (
          <p className="hint" style={{ marginTop: 12 }}>
            {data!.length - 1} more waiting
          </p>
        )}
      </div>
    </div>
  );
}
