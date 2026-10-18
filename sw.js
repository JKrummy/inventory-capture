/* Caches the app itself so the icon still opens with no signal.
   Photos waiting to upload live in IndexedDB, not here. */

const CACHE = 'jkinv-v1.4.0';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './voice.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first, cache second.

   Cache first would be faster, but it would also mean that the first time the
   app is opened after an update it quietly runs the old version. For a handful
   of small files that trade is not worth it. Online, you always get the current
   app; offline, you get the last copy that loaded, which is the whole point. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Dropbox must always hit the network, and must never be stored here.
  if (url.hostname.endsWith('dropbox.com') || url.hostname.endsWith('dropboxapi.com')) return;
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) => hit || caches.match('./index.html'))
      )
  );
});
