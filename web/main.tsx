import { createRoot } from 'react-dom/client';
import '@fontsource-variable/host-grotesk';
import { App } from './App';
import './styles.css';

// Scanning the phone QR code opens #/pair/<code>. Sign in before anything loads, then drop the code
// from the address bar, so every request the app makes is already signed in.
const pair = location.hash.match(/^#\/pair\/([\w-]+)/)?.[1];
if (pair) history.replaceState(null, '', '/#/');
const ready = pair
  ? fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-errand': '1' }, body: JSON.stringify({ password: pair }) }).catch(
      () => {},
    )
  : Promise.resolve();
void ready.then(() => createRoot(document.getElementById('root')!).render(<App />));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
