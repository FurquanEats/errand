import { useState } from 'react';
import { api, navigate, setDraft, useEvents, useResource } from '../api';
import { useApp } from '../context';
import { Panels } from './Panels';
import { Trackers } from './Trackers';
import { Icon } from './Icon';
import { CardMenu } from './CardMenu';

interface Action {
  id: string;
  title: string;
  description: string;
  icon: string;
  priority: number;
}

interface Weather {
  location: string;
  temperature: number;
  apparent: number;
  condition: string;
  high: number;
  low: number;
  sunset: string;
  unit: string;
}

/** "Fix the failing CI on acme/shop": the verb leads, in bold. */
function VerbTitle({ title }: { title: string }) {
  const [verb, ...rest] = title.split(' ');
  return (
    <>
      <b>{verb}</b> {rest.join(' ')}
    </>
  );
}

function WeatherSection({ w }: { w: Weather }) {
  const sunset = w.sunset ? new Date(w.sunset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <section className="sec" aria-label="Weather">
      <header className="sec-head">
        <h2>{w.location.split(',')[0]}</h2>
        <CardMenu label="Weather" items={[{ label: 'Change city', icon: 'settings', onClick: () => navigate('/settings/profile') }]} />
      </header>
      <div className="wx">
        <div className="wx-now" aria-label={`${w.temperature} degrees ${w.unit}`}>
          {w.temperature}
          <sup>°{w.unit}</sup>
        </div>
        <div className="wx-sub">
          <b>{w.condition}</b> · feels {w.apparent}°
          <br />
          {w.high}° / {w.low}°{sunset ? ` · sunset ${sunset}` : ''}
        </div>
      </div>
    </section>
  );
}

/**
 * Today: what needs you, the weather, trackers Errand keeps from your email and the panels you
 * asked for. Everything acts through the chat, so there's nothing else to learn.
 */
export function Feed({ onAct }: { onAct?: () => void }) {
  const { settings, toast } = useApp();
  const { data: actions } = useResource<Action[]>('/actions', ['actions.updated']);
  const { data: weather } = useResource<Weather | null>('/weather', ['settings.updated']);
  const [generating, setGenerating] = useState(false);
  // A few at a time, most urgent first, so trackers and panels stay in view.
  const [all, setAll] = useState(false);
  const shown = all ? actions : actions?.slice(0, 4);
  useEvents((e) => {
    if (e.type === 'actions.generating') setGenerating(e.value);
  });

  const run = async (a: Action) => {
    try {
      await api(`/actions/${a.id}/run`, { body: {} });
      navigate('/chat');
      onAct?.();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      {(!!actions?.length || generating) && (
        <section className="sec" aria-label="Needs you">
          <header className="sec-head">
            <h2>Needs you {!!actions?.length && <span className="n">{actions.length}</span>}</h2>
            <CardMenu
              label="Needs you"
              items={[{ label: 'Look for new things', icon: 'refresh', onClick: () => void api('/actions/refresh', { body: {} }) }]}
            />
          </header>
          <ul className="needs">
            {shown?.map((a) => (
              <li key={a.id} className={a.priority === 1 ? 'hot' : ''}>
                <button className="need" onClick={() => run(a)} title={a.description || undefined}>
                  <span className="t">
                    <VerbTitle title={a.title} />
                  </span>
                  {a.description && <span className="d">{a.description}</span>}
                </button>
                <span className="need-tools">
                  <button
                    className="icon-btn sm"
                    title="Ask about this or change it"
                    aria-label={`Ask about “${a.title}”`}
                    onClick={() => {
                      setDraft(`About “${a.title}”: `);
                      navigate('/chat');
                      onAct?.();
                    }}
                  >
                    <Icon name="chat" size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    title="Not useful"
                    aria-label={`Dismiss “${a.title}”`}
                    onClick={() => void api(`/actions/${a.id}/dismiss`, { body: {} })}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {generating && (
            <div className="thinking">
              <span className="spinner" style={{ width: 12, height: 12 }} /> Looking at your day…
            </div>
          )}
          {(actions?.length ?? 0) > 4 && (
            <button className="sec-more" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show ${actions!.length - 4} more`}
            </button>
          )}
        </section>
      )}
      {weather ? (
        <WeatherSection w={weather} />
      ) : (
        !settings?.location && (
          <a className="sec-hint" href="#/settings/profile">
            Set your city for the weather and local errands →
          </a>
        )
      )}
      <Trackers onAct={onAct} />
      <Panels column />
    </>
  );
}
