import { useEffect, useState } from 'react';
import { navigate, setDraft, timeAgo, useEvents, useResource } from '../api';
import { HandoffView } from './HandoffView';
import { Icon } from './Icon';

interface Task {
  id: string;
  goal: string;
  status: string;
  created_at: number;
}

const ACTIVE = ['queued', 'running', 'waiting'];
const LABEL: Record<string, [string, string]> = {
  queued: ['Queued', ''],
  running: ['Running', 'live'],
  waiting: ['Needs you', 'warn'],
  done: ['Done', 'ok'],
  failed: ['Stopped', 'err'],
  cancelled: ['Cancelled', ''],
};

/**
 * The browser column: the task Errand is working on, live. A new task takes the stage; with
 * several running, tabs switch between them. With none, recent tasks and an example.
 */
export function TaskPanel({ open, onLive, onClose }: { open: boolean; onLive: (live: boolean) => void; onClose: () => void }) {
  const { data: tasks } = useResource<Task[]>('/handoffs', ['handoff.created', 'handoff.status']);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const show = (e: Event) => setPicked((e as CustomEvent<string>).detail);
    window.addEventListener('errand:show-task', show);
    return () => window.removeEventListener('errand:show-task', show);
  }, []);
  useEvents((e) => {
    if (e.type === 'handoff.created') setPicked(e.id);
  });
  const active = tasks?.filter((t) => ACTIVE.includes(t.status)) ?? [];
  const newest = tasks?.[0];
  // A task picked by hand, else the newest running one, else one that just finished.
  const current = tasks?.find((t) => t.id === picked) ?? active[0] ?? (newest && Date.now() - newest.created_at < 30 * 60_000 ? newest : null);
  useEffect(() => onLive(active.length > 0), [active.length, onLive]);

  return (
    <aside className="task-col" aria-label="Browser">
      <header className="bar">
        <h2>{current && picked !== 'none' ? current.goal : 'Browser'}</h2>
        {current && picked !== 'none' && (
          <button className="icon-btn" onClick={() => setPicked('none')} aria-label="All browser tasks" title="All browser tasks">
            <Icon name="menu" size={17} />
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close the browser" title="Close">
          <Icon name="x" size={17} />
        </button>
      </header>
      {active.length > 1 && (
        <div className="task-tabs" role="tablist" aria-label="Running tasks">
          {active.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === current?.id} className={t.id === current?.id ? 'on' : ''} onClick={() => setPicked(t.id)}>
              {t.goal}
            </button>
          ))}
        </div>
      )}
      <div className="task-scroll">
        {current && picked !== 'none' ? (
          <HandoffView key={current.id} id={current.id} visible={open} />
        ) : (
          <div className="task-empty">
            <h3>{tasks?.length ? 'Browser tasks' : 'Nothing running'}</h3>
            <p>When Errand works on a website you watch it here, live. Take over any time to sign in or pick something yourself, then hand it back.</p>
            {!!tasks?.length && (
              <ul className="recent">
                {tasks.slice(0, 8).map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setPicked(t.id)}>
                      <span className="g">{t.goal}</span>
                      <span className="w">{timeAgo(t.created_at)}</span>
                      <span className={`status-pill ${LABEL[t.status]?.[1] ?? ''}`}>{LABEL[t.status]?.[0] ?? t.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!tasks?.length && (
              <button className="btn" onClick={() => (setDraft('Find me the cheapest flight to Goa next Friday'), navigate('/chat'))}>
                Try “find the cheapest flight to Goa next Friday”
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
