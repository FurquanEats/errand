import { useState } from 'react';
import { api, navigate, setDraft, useResource } from '../api';
import { CardMenu } from './CardMenu';

interface Item {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  label: string;
  detail: string;
  due: string;
  amount: string;
  at: number;
}

interface Tracker {
  id: 'jobs' | 'orders' | 'bills' | 'trips';
  title: string;
  total: number;
  today: number;
  items: Item[];
}

const GOOD = /^(offer|interview|delivered|paid|refunded|check_in)$/;
const BAD = /^(rejected|payment_failed|cancelled|changed)$/;
const SOON = /^(out_for_delivery|due|trial_ending|renewing|assessment|price_change)$/;

/** The date that matters: when a bill is due, a flight leaves, an interview starts. Not for deliveries. */
const due = (i: Item) => {
  const d = new Date(i.due);
  if (!i.due || Number.isNaN(d.getTime()) || !/due|renewing|trial_ending|booked|check_in|changed|interview/.test(i.status)) return '';
  const time = /T\d{2}:\d{2}/.test(i.due) && !/due|renewing|trial/.test(i.status);
  return d.toLocaleString([], { month: 'short', day: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) });
};

const when = (ts: number) => {
  const d = new Date(ts);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/**
 * Trackers Errand keeps on its own from email, like Hark's "Job Applications" panel:
 * "23 tracked, 1 with new activity today". Tapping a row asks about it in chat.
 */
export function Trackers({ onAct }: { onAct?: () => void }) {
  const { data } = useResource<Tracker[]>('/trackers', ['trackers.updated']);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {data
        ?.filter((t) => t.total)
        .map((t) => {
          const shown = open[t.id] ? t.items : t.items.slice(0, 4);
          return (
            <section key={t.id} className="sec" aria-label={t.title}>
              <header className="sec-head">
                <h2>
                  {t.title} <span className="n">{t.total}</span>
                </h2>
                {!!t.today && <span className="note">{t.today} new</span>}
                <CardMenu
                  label={t.title}
                  items={[
                    { label: 'Ask about these', icon: 'chat', onClick: () => (setDraft(`About my ${t.title.toLowerCase()}: `), navigate('/chat'), onAct?.()) },
                    { label: 'Check my email now', icon: 'refresh', onClick: () => void api('/trackers/scan', { body: {} }) },
                  ]}
                />
              </header>
              <ul className="track">
                {shown.map((i) => (
                  <li key={i.id}>
                    <button
                      className="track-row"
                      title={i.detail || undefined}
                      onClick={() => {
                        setDraft(`About ${t.id === 'jobs' ? `my application at ${i.title}` : `“${i.title}${i.subtitle ? `, ${i.subtitle}` : ''}”`}: `);
                        navigate('/chat');
                        onAct?.();
                      }}
                    >
                      <span className="when">{when(i.at)}</span>
                      <span>
                        <span className="who">
                          <b>{i.title}</b>
                          {i.subtitle ? <span> {i.subtitle}</span> : null}
                        </span>
                        <span className={`st ${GOOD.test(i.status) ? 'good' : BAD.test(i.status) ? 'bad' : SOON.test(i.status) ? 'soon' : ''}`}>
                          {[i.label, due(i), t.id === 'bills' && i.amount].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {t.items.length > 4 && (
                <button className="sec-more" onClick={() => setOpen({ ...open, [t.id]: !open[t.id] })}>
                  {open[t.id] ? 'Show fewer' : `Show all ${t.items.length}`}
                </button>
              )}
            </section>
          );
        })}
    </>
  );
}
