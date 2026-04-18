const CACHE_NAME = 'carnage-courts-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib/cloudsync.mjs',
  './lib/scheduler.mjs',
  './lib/scoring.mjs',
  './assets/bwf-logo.svg',
  './assets/icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Strategy: Network First, falling back to cache
  // This ensures the user gets the latest CSS/JS builds immediately, 
  // but if they are completely offline (gym without wifi), it recovers beautifully.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // Do not try to cache EventSource connections or Upstash REST calls
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache the fresh response for next time
        if (response && response.status === 200) {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        }
        return response;
      })
      .catch(() => {
        // Network failed -> return cache
        return caches.match(event.request);
      })
  );
});
