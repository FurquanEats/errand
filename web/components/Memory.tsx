import { useState } from 'react';
import { api, timeAgo, useResource } from '../api';
import { Icon } from './Icon';

interface Memory {
  id: string;
  content: string;
  category: string;
  source: string;
  updated_at: number;
}

const CATEGORIES = ['profile', 'preferences', 'people', 'places', 'work', 'health', 'finance', 'routine', 'specialty', 'general'];

export function MemoryPage() {
  const { data } = useResource<Memory[]>('/memories', ['memories.updated']);
  const [text, setText] = useState('');
  const [category, setCategory] = useState('general');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);

  const shown = (data ?? []).filter((m) => !filter || m.category === filter);
  const grouped = CATEGORIES.map((c) => [c, shown.filter((m) => m.category === c)] as const).filter(([, l]) => l.length);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>Memory</h1>
        <span className="spacer" />
        <span className="tag">
          {data?.length ?? 0} {data?.length === 1 ? 'memory' : 'memories'}
        </span>
      </div>
      <p className="lede">
        What Errand knows about you. It learns from your conversations automatically. Everything stays in your local database; edit or delete anything.
      </p>
      <form
        className="row"
        style={{ marginBottom: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await api('/memories', { body: { content: text, category } });
          setText('');
        }}
      >
        <input
          className="input grow"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Teach Errand something, e.g. “I’m allergic to peanuts”"
        />
        <select className="select" aria-label="Category" style={{ width: 140 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button className="btn primary">Add</button>
      </form>
      <div className="chips" style={{ margin: '18px 0 6px' }} role="group" aria-label="Show">
        <button className={`chip${!filter ? ' active' : ''}`} aria-pressed={!filter} onClick={() => setFilter('')}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip${filter === c ? ' active' : ''}`} aria-pressed={filter === c} onClick={() => setFilter(c)}>
            {c}
          </button>
        ))}
      </div>
      {!shown.length && (
        <div className="empty">
          <div className="big">Nothing yet</div>Chat with Errand and it will learn what matters to you.
        </div>
      )}
      {grouped.map(([cat, list]) => (
        <div key={cat}>
          <div className="section-title" style={{ textTransform: 'capitalize' }}>
            {cat}
          </div>
          <div className="list">
            {list.map((m) => (
              <div key={m.id} className="list-item">
                {editing?.id === m.id ? (
                  <form
                    className="row grow"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await api(`/memories/${m.id}`, { method: 'PATCH', body: { content: editing.content } });
                      setEditing(null);
                    }}
                  >
                    <input className="input grow" autoFocus value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
                    <button className="btn sm primary">Save</button>
                    <button type="button" className="btn sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="grow">{m.content}</span>
                    <span className="small muted" title={`Source: ${m.source}`}>
                      {timeAgo(m.updated_at)}
                    </span>
                    <button className="btn icon ghost sm" onClick={() => setEditing({ id: m.id, content: m.content })} aria-label="Edit">
                      <Icon name="edit" size={15} />
                    </button>
                    <button className="btn icon ghost sm" onClick={() => api(`/memories/${m.id}`, { method: 'DELETE' })} aria-label="Delete">
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
