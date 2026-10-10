import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface CardMenuItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
}

/** The ⋮ button on a live card: its settings and actions, out of the way until needed. */
export function CardMenu({ label, items }: { label: string; items: CardMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="card-menu" ref={ref}>
      <button className="icon-btn sm" aria-label={`${label}: more`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="card-menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`menu-item${it.danger ? ' danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <Icon name={it.icon} size={15} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
