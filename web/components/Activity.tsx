import { useState } from 'react';
import { api, navigate, timeAgo, useResource } from '../api';
import { useApp } from '../context';
import { HandoffView } from './HandoffView';
import { Icon } from './Icon';

interface Handoff {
  id: string;
  goal: string;
  status: string;
  result: string | null;
  conversation_id: string | null;
  created_at: number;
  live: boolean;
}

const STATUS_CLS: Record<string, string> = { running: 'accent', waiting: 'warn', done: 'ok', failed: 'err', queued: '', cancelled: '' };

/** Every browser task the agent has run, with live view for active ones and a replayable step log. */
export function ActivityPage() {
  const { toast } = useApp();
  const { data } = useResource<Handoff[]>('/handoffs', ['handoff.created', 'handoff.status']);
  const [open, setOpen] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [url, setUrl] = useState('');

  const start = async () => {
    if (!goal.trim()) return;
    try {
      const { id } = await api('/handoffs', { body: { goal, startUrl: url || undefined } });
      setGoal('');
      setUrl('');
      setOpen(id);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Browser tasks</h1>
      </div>
      <p className="lede">
        The browser agent works on real websites for you. Watch it live, steer it, or cancel any time. It always asks before paying, booking or sending
        anything.
      </p>
      <form
        className="card"
        style={{ marginBottom: 20 }}
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="field">
          <label>Hand off a task</label>
          <textarea
            className="textarea"
            style={{ minHeight: 60 }}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Renew my vehicle registration on the DMV site · Find the cheapest nonstop flight to Denver next Friday morning · Cancel my gym membership"
          />
        </div>
        <div className="row">
          <input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Start URL (optional)" />
          <button className="btn primary" disabled={!goal.trim()}>
            <Icon name="globe" size={16} /> Start
          </button>
        </div>
      </form>
      <div className="list">
        {data?.map((h) => (
          <div key={h.id}>
            <div className="list-item clickable" onClick={() => setOpen(open === h.id ? null : h.id)}>
              <span className={`tag ${STATUS_CLS[h.status] ?? ''}`} style={{ textTransform: 'capitalize' }}>
                {h.status}
              </span>
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.goal}
              </span>
              {h.conversation_id && (
                <button
                  className="btn sm ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/c/${h.conversation_id}`);
                  }}
                >
                  Chat
                </button>
              )}
              <span className="small muted">{timeAgo(h.created_at)}</span>
            </div>
            {open === h.id && (
              <div style={{ marginTop: 8 }}>
                <HandoffView id={h.id} />
              </div>
            )}
          </div>
        ))}
        {data && !data.length && (
          <div className="empty">
            <div className="big">No browser tasks yet</div>Hand one off above, or ask in chat.
          </div>
        )}
      </div>
    </div>
  );
}
