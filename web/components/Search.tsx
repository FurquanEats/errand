import { useEffect, useRef, useState } from 'react';
import { api, navigate, timeAgo } from '../api';
import { Icon } from './Icon';

interface Hit {
  id: string;
  title: string;
  snippet: string;
  updated_at: number;
}

/** ⌘K / Ctrl+K search across every conversation. */
export function SearchModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(
      () =>
        api<Hit[]>(`/search?q=${encodeURIComponent(q)}`)
          .then((h) => (setHits(h), setActive(0)))
          .catch(() => {}),
      150,
    );
    return () => clearTimeout(t);
  }, [q]);

  const open = (h: Hit) => {
    navigate(`/c/${h.id}`);
    onClose();
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal" role="dialog" aria-label="Search">
        <div className="search-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            placeholder="Search conversations"
            aria-label="Search conversations"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') setActive((a) => Math.min(hits.length - 1, a + 1));
              if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
              if (e.key === 'Enter' && hits[active]) open(hits[active]);
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="search-results">
          {hits.map((h, i) => (
            <a key={h.id} className={`search-result ${i === active ? 'active' : ''}`} href={`#/c/${h.id}`} onClick={onClose} onMouseEnter={() => setActive(i)}>
              <div className="top">
                <b>{h.title}</b>
                <span>{timeAgo(h.updated_at)}</span>
              </div>
              {h.snippet && <div className="snip">{h.snippet}</div>}
            </a>
          ))}
          {q.trim().length >= 2 && !hits.length && <div className="empty small">No matches</div>}
        </div>
      </div>
    </div>
  );
}
