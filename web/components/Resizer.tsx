import { useEffect, useRef } from 'react';

/**
 * A column edge you can drag (or move with the arrow keys) to make Today or the browser wider.
 * Widths are remembered on this device; a double-click puts the column back.
 */
export function Resizer({
  label,
  value,
  min,
  max,
  fallback,
  side,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  fallback: number;
  side: 'left' | 'right'; // which edge of its column the handle sits on
  onChange: (w: number) => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      onChange(clamp(d.w + (side === 'right' ? e.clientX - d.x : d.x - e.clientX)));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove('resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });
  return (
    <div
      className={`resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, w: value };
        document.body.classList.add('resizing');
      }}
      onDoubleClick={() => onChange(fallback)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
        const shrink = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) onChange(clamp(value + step));
        else if (e.key === shrink) onChange(clamp(value - step));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** A remembered width, in pixels. */
export function savedWidth(key: string, fallback: number) {
  try {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveWidth(key: string, w: number) {
  try {
    localStorage.setItem(key, String(w));
  } catch {
    /* private mode: just this session */
  }
}
