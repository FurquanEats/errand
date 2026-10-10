// Minimal service worker so Errand can be installed as an app on iOS, Android and desktop.
// It caches the app shell only; all data stays live from your own server.
const SHELL = 'errand-shell-v3';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // Network first, so a running server always serves the latest build; the cache is only an offline fallback.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
