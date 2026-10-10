import { useEffect, useRef, useState } from 'react';
import { api, useEvents } from '../api';
import { useApp } from '../context';
import { Icon } from './Icon';

interface Step {
  n: number;
  action: string;
  detail: string;
  url: string;
}

interface HandoffData {
  id: string;
  goal: string;
  status: string;
  result: string | null;
  steps: Step[];
  live: boolean;
  control?: boolean;
  frame?: string;
}

interface Frame {
  image: string;
  url: string;
  width: number;
  height: number;
}

const ACTIVE = ['queued', 'running', 'waiting'];
const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Waiting for a free browser', cls: '' },
  running: { label: 'Working', cls: 'live' },
  waiting: { label: 'Needs you', cls: 'warn' },
  done: { label: 'Done', cls: 'ok' },
  failed: { label: 'Stopped', cls: 'err' },
  cancelled: { label: 'Cancelled', cls: '' },
};

export const urlLabel = (url?: string) => {
  try {
    const u = new URL(url ?? '');
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return 'New tab';
  }
};

/** Bring a task up in the browser column (from chat, a request, anywhere). */
export function showTask(id: string) {
  window.dispatchEvent(new CustomEvent('errand:show-task', { detail: id }));
}

/** A task's record, kept current by live events. */
function useHandoff(id: string) {
  const [h, setH] = useState<HandoffData | null>(null);
  useEffect(() => {
    let off = false;
    setH(null);
    api<HandoffData>(`/handoffs/${id}`)
      .then((d) => !off && setH(d))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [id]);
  useEvents((e) => {
    if (e.id !== id) return;
    if (e.type === 'handoff.step') setH((cur) => (cur ? { ...cur, steps: [...cur.steps, e.step] } : cur));
    else if (e.type === 'handoff.control') setH((cur) => (cur ? { ...cur, control: e.on } : cur));
    else if (e.type === 'handoff.status') {
      const done = !ACTIVE.includes(e.status);
      setH((cur) => (cur ? { ...cur, status: e.status, result: e.result ?? cur.result, live: !done, control: done ? false : cur.control } : cur));
      // The final screen is saved when a task ends.
      if (done)
        setTimeout(
          () =>
            api<HandoffData>(`/handoffs/${id}`)
              .then((d) => setH((cur) => (cur ? { ...cur, frame: d.frame } : d)))
              .catch(() => {}),
          600,
        );
    }
  });
  return h;
}

/** The task's screen: live while it runs (only while you're looking), its last screen after. */
function useLiveFrame(id: string, on: boolean) {
  const [frame, setFrame] = useState<Frame | null>(null);
  useEffect(() => {
    if (!on) return;
    const src = new EventSource(`/api/handoffs/${id}/live`);
    src.onmessage = (m) => {
      try {
        setFrame(JSON.parse(m.data));
      } catch {
        /* a partial message */
      }
    };
    return () => src.close();
  }, [id, on]);
  return frame;
}

type Input =
  | { type: 'click' | 'move' | 'down' | 'up'; x: number; y: number; button?: string; count?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
  | { type: 'text'; text: string };

const BUTTONS = ['left', 'middle', 'right'];

/**
 * The live browser. While you're in control it is a remote control: your clicks, scrolls and
 * typing go to the real page, in order, and the agent waits until you hand it back.
 */
function Screen({ id, live, control, still, url }: { id: string; live: boolean; control: boolean; still?: string; url?: string }) {
  const frame = useLiveFrame(id, live);
  const view = useRef<HTMLDivElement>(null);
  const queue = useRef(Promise.resolve());
  const inFlight = useRef(0);
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; t?: ReturnType<typeof setTimeout> }>({ dx: 0, dy: 0, x: 0, y: 0 });
  const [typed, setTyped] = useState('');
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !control && setBig(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [big, control]);

  const send = (e: Input, droppable = false) => {
    if (droppable && inFlight.current > 1) return; // a pointer move can be skipped; a click can't
    inFlight.current++;
    queue.current = queue.current
      .then(() => api(`/handoffs/${id}/input`, { body: e }))
      .catch(() => {})
      .finally(() => void inFlight.current--);
  };
  const ratio = useRef(16 / 10);
  if (frame) ratio.current = frame.width / frame.height;
  // Where on the page you pointed, 0–1 across, allowing for the bars around a letterboxed screen.
  const at = (clientX: number, clientY: number) => {
    const r = view.current!.getBoundingClientRect();
    let w = r.width;
    let h = r.height;
    if (w / h > ratio.current) w = h * ratio.current;
    else h = w / ratio.current;
    return { x: (clientX - r.left - (r.width - w) / 2) / w, y: (clientY - r.top - (r.height - h) / 2) / h };
  };

  // Wheel needs a non-passive listener to keep the page behind from scrolling.
  useEffect(() => {
    const el = view.current;
    if (!el || !control) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const w = wheel.current;
      Object.assign(w, at(e.clientX, e.clientY));
      w.dx += e.deltaX;
      w.dy += e.deltaY;
      w.t ??= setTimeout(() => {
        send({ type: 'wheel', x: w.x, y: w.y, dx: w.dx, dy: w.dy });
        w.dx = w.dy = 0;
        w.t = undefined;
      }, 40);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [control]);
  useEffect(() => {
    if (control) view.current?.focus();
  }, [control]);

  const image = frame?.image ?? still;
  const aspect = frame ? `${frame.width} / ${frame.height}` : undefined;
  const shownUrl = frame?.url ?? url;
  return (
    <div className={`screen${control ? ' control' : ''}${big ? ' big' : ''}`}>
      <div className="screen-bar">
        {live && image && !control && (
          <span className="live-tag">
            <span className="live-dot pulse" /> Live
          </span>
        )}
        <span className="url" title={shownUrl}>
          <Icon name="lock" size={11} />
          <span>{urlLabel(shownUrl)}</span>
        </span>
        {shownUrl && /^https?:\/\//.test(shownUrl) && (
          <a
            className="icon-btn sm"
            href={shownUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open this page in your own browser"
            title="Open in your browser"
          >
            <Icon name="external" size={14} />
          </a>
        )}
        <button
          className="icon-btn sm"
          onClick={() => setBig(!big)}
          aria-label={big ? 'Make the screen smaller' : 'Make the screen bigger'}
          title={big ? 'Smaller (Esc)' : 'Bigger'}
          aria-pressed={big}
        >
          <Icon name={big ? 'shrink' : 'expand'} size={14} />
        </button>
      </div>
      <div
        ref={view}
        className="screen-view"
        style={{ aspectRatio: aspect }}
        tabIndex={control ? 0 : -1}
        role={control ? 'application' : undefined}
        aria-label={control ? 'The task’s browser. You are in control: click, scroll and type here.' : undefined}
        onContextMenu={(e) => control && e.preventDefault()}
        onPointerDown={(e) => {
          if (!control) return;
          view.current?.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e.clientX, e.clientY);
          if (e.pointerType === 'mouse') send({ type: 'down', ...p, button: BUTTONS[e.button] ?? 'left', count: e.detail || 1 });
          else touch.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          if (!control) return;
          const p = at(e.clientX, e.clientY);
          const t = touch.current;
          if (e.pointerType === 'mouse') return send({ type: 'move', ...p }, true);
          if (!t) return;
          // A finger drag scrolls the page, like it would on the site itself.
          const dy = t.y - e.clientY;
          const dx = t.x - e.clientX;
          if (Math.abs(dy) + Math.abs(dx) < 6 && !t.moved) return;
          t.moved = true;
          t.x = e.clientX;
          t.y = e.clientY;
          send({ type: 'wheel', ...p, dx: dx * 2, dy: dy * 2 }, true);
        }}
        onPointerUp={(e) => {
          if (!control) return;
          const p = at(e.clientX, e.clientY);
          if (e.pointerType === 'mouse') send({ type: 'up', ...p, button: BUTTONS[e.button] ?? 'left', count: e.detail || 1 });
          else if (touch.current && !touch.current.moved) send({ type: 'click', ...p });
          touch.current = null;
        }}
        onKeyDown={(e) => {
          if (!control || e.nativeEvent.isComposing) return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // the paste event sends the text
          e.preventDefault();
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({ type: 'text', text: e.key });
          else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))
            send({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
        }}
        onPaste={(e) => {
          if (!control) return;
          e.preventDefault();
          const text = e.clipboardData.getData('text');
          if (text) send({ type: 'text', text });
        }}
      >
        {image ? (
          <img src={`data:image/jpeg;base64,${image}`} alt={control ? '' : 'The browser agent’s screen'} draggable={false} />
        ) : (
          <span>{live ? 'Opening the browser…' : 'No screen captured'}</span>
        )}
      </div>
      {control && (
        <form
          className="control-bar"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed) send({ type: 'text', text: typed });
            send({ type: 'key', key: 'Enter' });
            setTyped('');
          }}
        >
          <span>You’re in control</span>
          <input
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type into the page, Enter to send"
            aria-label="Type into the page"
          />
        </form>
      )}
    </div>
  );
}

/** One task, in full: its status, the live screen, take over, steps and steering. */
export function HandoffView({ id, visible = true }: { id: string; visible?: boolean }) {
  const { toast } = useApp();
  const h = useHandoff(id);
  const [steer, setSteer] = useState('');
  const [all, setAll] = useState(false);
  if (!h) return null;
  const active = ACTIVE.includes(h.status);
  const st = STATUS[h.status] ?? STATUS.queued;
  const steps = all ? h.steps : h.steps.slice(-8);
  const control = !!h.control && active;
  const take = (on: boolean) => api(`/handoffs/${id}/control`, { body: { on } }).catch((e) => toast((e as Error).message));

  return (
    <div className="hv">
      <div className="hv-status">
        <span className={`status-pill ${st.cls}`}>
          {st.cls === 'live' && <span className="live-dot" />}
          {control ? 'Paused for you' : st.label}
        </span>
        <span className="grow">{active ? (h.steps.at(-1)?.detail ?? 'Starting…') : ''}</span>
      </div>

      {visible && <Screen id={id} live={active} control={control} still={h.frame} url={h.steps.at(-1)?.url} />}

      {active && (
        <div className="row">
          {control ? (
            <button className="btn primary" onClick={() => take(false)}>
              <Icon name="check" size={15} /> Hand back to Errand
            </button>
          ) : (
            <button className="btn" onClick={() => take(true)} title="Pause the agent and use the page yourself: sign in, solve a check, pick something">
              <Icon name="hand" size={15} /> Take over
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost danger" onClick={() => api(`/handoffs/${id}/cancel`, { body: {} })}>
            Stop task
          </button>
        </div>
      )}

      {h.result && !active && <div className={`hv-result${h.status === 'failed' ? ' err' : ''}`}>{h.result}</div>}

      <section aria-label="Steps">
        <h3 className="mini-title" style={{ marginTop: 4 }}>
          {h.steps.length ? `${h.steps.length} step${h.steps.length === 1 ? '' : 's'}` : 'Steps'}
        </h3>
        {h.steps.length > 8 && (
          <button className="link-btn" style={{ marginBottom: 6 }} onClick={() => setAll(!all)}>
            {all ? 'Show recent steps' : `Show all ${h.steps.length}`}
          </button>
        )}
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.n} className={i === steps.length - 1 && active ? 'now' : ''}>
              <span className="n">{s.n}</span>
              <span className="d">
                {s.detail}
                {s.url && urlLabel(s.url) !== urlLabel(steps[i - 1]?.url) && <span className="u">{urlLabel(s.url)}</span>}
              </span>
            </li>
          ))}
          {!h.steps.length && (
            <li className={active ? 'now' : ''}>
              <span className="n">·</span>
              <span className="d">{active ? 'Opening the browser…' : 'No steps recorded'}</span>
            </li>
          )}
        </ol>
      </section>

      {active && !control && (
        <form
          className="steer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!steer.trim()) return;
            void api(`/handoffs/${id}/steer`, { body: { text: steer } });
            toast('Sent. It’ll take that into account on its next step.');
            setSteer('');
          }}
        >
          <input
            className="input"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder="Tell it something: “pick the window seat”"
            aria-label="Tell the browser agent something"
          />
          <button className="btn" disabled={!steer.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

/** A task as one line in chat: what it's doing now, and a way to watch. */
export function TaskLine({ id, thumb }: { id: string; thumb?: boolean }) {
  const h = useHandoff(id);
  if (!h) return null;
  const active = ACTIVE.includes(h.status);
  const st = STATUS[h.status] ?? STATUS.queued;
  return (
    <div className="task-line">
      <div className="t">
        {active ? <span className="live-dot pulse" /> : <Icon name={h.status === 'done' ? 'check' : 'globe'} size={15} />}
        <span>{h.goal}</span>
      </div>
      <div className="s">{active ? (h.control ? 'Paused while you’re in control' : (h.steps.at(-1)?.detail ?? 'Starting…')) : (h.result ?? st.label)}</div>
      <button className="btn sm" onClick={() => showTask(id)}>
        {active ? 'Watch' : 'Open'}
      </button>
      {thumb && h.frame && (
        <div className="thumb">
          <img src={`data:image/jpeg;base64,${h.frame}`} alt="" />
        </div>
      )}
    </div>
  );
}
