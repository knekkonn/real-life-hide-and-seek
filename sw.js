// Bump this identifier whenever any shell file changes. One worker serves one complete shell.
const CACHE_NAME = 'hide-seek-shell-v2.3.0';
const APP_SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './assets/icon.svg',
  './js/config.js', './js/backend.js', './js/skills.js', './js/utils.js', './js/gps.js', './js/transactions.js', './js/store.js', './js/map.js', './js/game-service.js', './js/main.js'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, {cache:'reload'})))));
  // Do not skipWaiting: running games retain their entire current version.
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('hide-seek-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try { return await fetch(event.request); }
    catch {
      if (event.request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error(); // Never return HTML as a JavaScript module.
    }
  })());
});
