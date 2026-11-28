const CACHE_NAME = 'tasks-pwa-v19';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=19',
  './board-views.css?v=19',
  './day-view.css?v=19',
  './mobile.css?v=19',
  './js/utils.js',
  './js/notes-meta.js',
  './js/fx.js',
  './js/timers-dock.js',
  './js/api.js',
  './js/journal-store.js',
  './js/day-view.js',
  './js/analytics.js',
  './js/views.js',
  './js/mobile-ux.js',
  './js/voice-bot.js',
  './js/ai-actions.js',
  './js/voice.js',
  './js/telegram-ui.js',
  './js/ui.js',
  './js/modals.js',
  './js/app.js?v=19',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isCodeAsset =
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    /\.(html|css|js)$/i.test(url.pathname);

  // Network-first із ревалідацією (cache: 'no-cache'), щоб JS-модулі не розсинхронізовувались через HTTP-кеш GitHub Pages
  if (isCodeAsset) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((c) => c || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
