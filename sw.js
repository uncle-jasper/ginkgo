const CACHE = 'ginkgo-v1';
const ASSETS = [
  '/ginkgo/',
  '/ginkgo/index.html',
  '/ginkgo/editor.html',
  '/ginkgo/manifest.json',
  '/ginkgo/icon-192.png',
  '/ginkgo/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Network-first for HTML (index.html and editor.html) so deploys are visible immediately
  const isHTML = e.request.destination === 'document' ||
    e.request.url.endsWith('/ginkgo/') ||
    e.request.url.endsWith('/ginkgo/index.html') ||
    e.request.url.endsWith('/ginkgo/editor.html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for all other assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/ginkgo/index.html'));
    })
  );
});
