import { publish } from './bus.ts';
import { getSettings } from './settings.ts';

/**
 * Notifications reach you two ways:
 *  - in the app (browser notification when the tab is in the background)
 *  - optionally as a phone push via ntfy (https://ntfy.sh or your own ntfy server, no account needed).
 * Push messages stay generic ("needs your approval") so no personal details leave your server.
 */
export async function notify(n: { title: string; body?: string; url?: string; urgent?: boolean }) {
  publish({ type: 'notify', ...n });
  const { ntfyUrl } = getSettings().notifications;
  if (!ntfyUrl) return;
  try {
    await fetch(ntfyUrl, {
      method: 'POST',
      headers: { Title: n.title, Priority: n.urgent ? 'high' : 'default', Tags: n.urgent ? 'warning' : 'sparkles' },
      body: n.body ?? n.title,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[notify]', (err as Error).message);
  }
}
