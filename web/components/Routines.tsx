import { useState } from 'react';
import { api, navigate, timeAgo, useResource } from '../api';
import { useApp } from '../context';
import { Icon } from './Icon';

interface Routine {
  id: string;
  title: string;
  prompt: string;
  schedule: { kind: 'once' | 'daily' | 'weekly' | 'interval'; at?: string; time?: string; days?: number[]; hours?: number };
  description: string;
  enabled: boolean;
  last_run: number | null;
  last_conversation: string | null;
}

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const TEMPLATES = [
  {
    title: 'Morning briefing',
    prompt:
      'Give me a short briefing for today: weather, my calendar, important unread emails, and anything due in my projects. Pin action buttons for anything I should handle.',
    kind: 'daily',
    time: '08:00',
  },
  {
    title: 'Weekly bills check',
    prompt:
      'Check my email for bills and payment reminders from the last week. List what is due, when, and how much. Pin an action button for each one that needs paying.',
    kind: 'weekly',
    time: '09:00',
    days: [0],
  },
  {
    title: 'Inbox tidy',
    prompt:
      'Look at my unread email from the last day. Archive newsletters and promotions into a “Later” folder, flag anything that needs a reply, and summarize what is left.',
    kind: 'daily',
    time: '18:00',
  },
] as const;

type Draft = {
  id?: string;
  title: string;
  prompt: string;
  kind: 'once' | 'daily' | 'weekly' | 'interval';
  at: string;
  time: string;
  days: number[];
  hours: number;
};
const inAnHour = () => new Date(Date.now() + 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const blank: Draft = { title: '', prompt: '', kind: 'daily', at: inAnHour(), time: '08:00', days: [1, 2, 3, 4, 5], hours: 6 };

/** Scheduled tasks Errand runs by itself. */
export function RoutinesPage() {
  const { toast } = useApp();
  const { data } = useResource<Routine[]>('/routines', ['routines.updated']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!draft) return;
    setErr('');
    const body = {
      title: draft.title,
      prompt: draft.prompt,
      schedule:
        draft.kind === 'once'
          ? { kind: 'once', at: new Date(draft.at).toISOString() }
          : draft.kind === 'interval'
            ? { kind: 'interval', hours: draft.hours }
            : draft.kind === 'weekly'
              ? { kind: 'weekly', time: draft.time, days: draft.days }
              : { kind: 'daily', time: draft.time },
    };
    try {
      if (draft.id) await api(`/routines/${draft.id}`, { method: 'PATCH', body });
      else await api('/routines', { body });
      setDraft(null);
      toast('Routine saved');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>Scheduled tasks</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setDraft({ ...blank })}>
          <Icon name="plus" size={15} /> New routine
        </button>
      </div>
      <p className="lede">
        Things Errand does on its own, on a schedule. Each run happens in its own conversation, and it still asks before doing anything irreversible. You can
        also just say “every Monday at 9, check…” in chat.
      </p>

      <div className="list">
        {data?.map((r) => (
          <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <span className="icon-chip">
              <Icon name="clock" size={17} />
            </span>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{r.title}</div>
              <div className="small muted">
                {r.description}
                {r.last_run ? ` · last ran ${timeAgo(r.last_run)}` : ''}
              </div>
              <div className="small" style={{ marginTop: 6, color: 'var(--ink-2)' }}>
                {r.prompt}
              </div>
            </div>
            <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              {r.last_conversation && (
                <button className="btn sm ghost" onClick={() => navigate(`/c/${r.last_conversation}`)}>
                  Last run
                </button>
              )}
              <button className="btn sm" onClick={async () => navigate(`/c/${(await api(`/routines/${r.id}/run`, { body: {} })).conversationId}`)}>
                Run now
              </button>
              <button
                className={`switch ${r.enabled ? 'on' : ''}`}
                role="switch"
                aria-checked={r.enabled}
                title={r.enabled ? 'On' : 'Off'}
                onClick={() => api(`/routines/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } })}
              />
              <button
                className="btn icon ghost sm"
                title="Edit"
                onClick={() =>
                  setDraft({
                    ...blank,
                    id: r.id,
                    title: r.title,
                    prompt: r.prompt,
                    kind: r.schedule.kind,
                    at: r.schedule.at ? new Date(Date.parse(r.schedule.at) - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : blank.at,
                    time: r.schedule.time ?? '08:00',
                    days: r.schedule.days ?? [],
                    hours: r.schedule.hours ?? 6,
                  })
                }
              >
                <Icon name="edit" size={15} />
              </button>
              <button
                className="btn icon ghost sm"
                title="Delete"
                onClick={() => confirm(`Delete “${r.title}”?`) && api(`/routines/${r.id}`, { method: 'DELETE' })}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {data && !data.length && (
        <>
          <div className="section-title">Start from a template</div>
          <div className="actions-row">
            {TEMPLATES.map((t) => (
              <button key={t.title} className="action-card" onClick={() => setDraft({ ...blank, ...t, days: 'days' in t ? [...t.days] : blank.days })}>
                <span className="icon-chip">
                  <Icon name="clock" size={17} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="t" style={{ display: 'block' }}>
                    {t.title}
                  </span>
                  <span className="d" style={{ display: 'block' }}>
                    {t.prompt}
                  </span>
                </span>
                <span className="go">
                  Set up <Icon name="arrowRight" size={13} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {draft && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setDraft(null)}>
          <div className="modal">
            <h2>{draft.id ? 'Edit routine' : 'New routine'}</h2>
            <div className="field" style={{ marginTop: 16 }}>
              <label>Name</label>
              <input
                className="input"
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Morning briefing"
              />
            </div>
            <label className="field">
              <span className="label">What should Errand do?</span>
              <textarea
                className="textarea"
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="Check my email for…"
              />
            </label>
            <div className="field">
              <label>When</label>
              <div className="tabs" style={{ marginBottom: 6 }}>
                {(['once', 'daily', 'weekly', 'interval'] as const).map((k) => (
                  <button key={k} className={`tab ${draft.kind === k ? 'active' : ''}`} onClick={() => setDraft({ ...draft, kind: k })}>
                    {k === 'once' ? 'Once' : k === 'daily' ? 'Every day' : k === 'weekly' ? 'Some days' : 'Every few hours'}
                  </button>
                ))}
              </div>
              {draft.kind === 'once' ? (
                <input
                  className="input"
                  type="datetime-local"
                  style={{ maxWidth: 240 }}
                  value={draft.at}
                  onChange={(e) => setDraft({ ...draft, at: e.target.value })}
                />
              ) : draft.kind === 'interval' ? (
                <div className="row">
                  <span className="small muted">Every</span>
                  <input
                    className="input"
                    type="number"
                    min={0.25}
                    step={0.25}
                    style={{ width: 90 }}
                    value={draft.hours}
                    onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })}
                  />
                  <span className="small muted">hours</span>
                </div>
              ) : (
                <div className="row">
                  {draft.kind === 'weekly' &&
                    DAYS.map((d, i) => (
                      <button
                        key={i}
                        className={`btn icon sm ${draft.days.includes(i) ? 'primary' : ''}`}
                        onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                      >
                        {d}
                      </button>
                    ))}
                  <input
                    className="input"
                    type="time"
                    style={{ width: 130 }}
                    value={draft.time}
                    onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                  />
                </div>
              )}
            </div>
            {err && (
              <div className="error-box" style={{ marginBottom: 12 }}>
                {err}
              </div>
            )}
            <div className="foot">
              <button className="btn" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!draft.title.trim() || !draft.prompt.trim()} onClick={save}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
