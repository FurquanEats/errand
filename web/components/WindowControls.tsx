import { useEffect, useState } from 'react';

type Host = { postMessage: (m: string) => void; addEventListener: (t: 'message', f: (e: { data: unknown }) => void) => void };
const host = (window as unknown as { chrome?: { webview?: Host } }).chrome?.webview;

/** True inside Errand's own Windows window, where the page draws the title bar. */
export const framed = !!host;

/** Minimise, maximise and close, drawn by the page because Errand's window has no title bar of its own. */
export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    host?.addEventListener('message', (e) => {
      if (e.data === 'maximized' || e.data === 'restored') setMax(e.data === 'maximized');
    });
  }, []);
  if (!host) return null;
  const send = (m: string) => () => host.postMessage(m);
  return (
    <div className="window-controls">
      <button onClick={send('minimize')} aria-label="Minimise" title="Minimise">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button onClick={send('maximize')} aria-label={max ? 'Restore' : 'Maximise'} title={max ? 'Restore' : 'Maximise'}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor">
          {max ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <rect x=".5" y=".5" width="9" height="9" />}
        </svg>
      </button>
      <button className="close" onClick={send('close')} aria-label="Close" title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
