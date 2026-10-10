import { useState } from 'react';
import { api, navigate, timeAgo, useEvents, useResource } from '../api';
import { useApp } from '../context';
import { Icon } from './Icon';
import { CardMenu } from './CardMenu';
import { usePrefersDark } from '../theme';

export interface Panel {
  id: string;
  title: string;
  request: string;
  data: string | null;
  error: string | null;
  size: 'sm' | 'md' | 'lg';
  refresh_minutes: number;
  refreshed_at: number | null;
}

/** Panels load from a sandboxed endpoint whose CSP forbids network access: they can only render their data. */
function PanelFrame({ panel }: { panel: Panel }) {
  const theme = usePrefersDark() ? 'dark' : 'light';
  return (
    <iframe sandbox="allow-scripts" src={`/api/panels/${panel.id}/frame?theme=${theme}&v=${panel.refreshed_at ?? 0}`} title={panel.title} loading="lazy" />
  );
}

export function Panels({ column }: { column?: boolean } = {}) {
  const { toast } = useApp();
  const { data: panels, reload } = useResource<Panel[]>('/panels', ['panels.updated']);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Panel | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEvents((e) => {
    if (e.type === 'panels.refreshing')
      setRefreshing((cur) => {
        const next = new Set(cur);
        e.value ? next.add(e.id) : next.delete(e.id);
        return next;
      });
  });

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (editing) {
        // Replies go to the main chat, which can answer from the panel's data or change the panel.
        const { id } = await api<{ id: string }>('/conversations/main');
        await api(`/conversations/${id}/messages`, { body: { text: `About my “${editing.title}” panel: ${text}` } });
        navigate('/chat');
      } else await api('/panels', { body: { request: text } });
      setAdding(false);
      setEditing(null);
      setText('');
      void reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {panels?.map((p) => (
        <section key={p.id} className="sec" aria-label={p.title}>
          <header className="sec-head">
            <h2>{p.title}</h2>
            {refreshing.has(p.id) && <span className="spinner" style={{ width: 12, height: 12 }} aria-label="Refreshing" />}
            <CardMenu
              label={p.title}
              items={[
                { label: 'Ask or change it', icon: 'chat', onClick: () => (setEditing(p), setText('')) },
                { label: 'Refresh now', icon: 'refresh', onClick: () => void api(`/panels/${p.id}/refresh`, { body: {} }) },
                {
                  label: p.size === 'lg' ? 'Make it smaller' : 'Make it taller',
                  icon: 'sidebar',
                  onClick: () => void api(`/panels/${p.id}`, { method: 'PATCH', body: { size: p.size === 'sm' ? 'md' : p.size === 'md' ? 'lg' : 'sm' } }),
                },
                {
                  label: 'Remove',
                  icon: 'trash',
                  danger: true,
                  onClick: () => confirm(`Remove “${p.title}”?`) && void api(`/panels/${p.id}`, { method: 'DELETE' }),
                },
              ]}
            />
          </header>
          {p.data ? (
            <div className={`panel-frame ${p.size}`} title={p.refreshed_at ? `Updated ${timeAgo(p.refreshed_at)}` : undefined}>
              <PanelFrame panel={p} />
            </div>
          ) : (
            <div className={`panel-msg${p.error ? ' err' : ''}`}>
              {p.error ?? (
                <>
                  <span className="spinner" style={{ width: 12, height: 12 }} /> Building…
                </>
              )}
            </div>
          )}
        </section>
      ))}
      {column && (
        <button className="add-panel" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> New panel
        </button>
      )}

      {(adding || editing) && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && !busy && (setAdding(false), setEditing(null))}>
          <div className="modal">
            <h2>{editing ? `Reply to “${editing.title}”` : 'Build a panel'}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {editing ? 'Ask about what it shows, or say what to change.' : 'Describe a mini-app for your home screen. It refreshes itself with live data.'}
            </p>
            <textarea
              className="textarea"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                editing
                  ? 'e.g. which of these needs a follow-up? · show it as a bar chart for the last 14 days'
                  : 'e.g. My next 5 calendar events · Bitcoin and ETH prices · Top Hacker News stories · Unread emails from my boss · Strava miles this week (via MCP)'
              }
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
            />
            <div className="foot" style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={() => (setAdding(false), setEditing(null))}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
                {busy ? (
                  <>
                    <span className="spinner" style={{ borderTopColor: 'currentColor' }} /> Building…
                  </>
                ) : editing ? (
                  'Send'
                ) : (
                  'Build'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
