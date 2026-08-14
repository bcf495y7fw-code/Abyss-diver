/* Service worker — precache the app shell, then serve cache-first.
   When you change files, bump CACHE so old copies get replaced. */
const CACHE = 'abyss-v6';
const SHELL = [
  './', './index.html', './style.css', './game.js',
  './manifest.webmanifest', './icons/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  if (url.origin === location.origin) {
    // same-origin: stale-while-revalidate
    e.respondWith(
      caches.match(req).then(cached => {
        const fresh = fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
  } else {
    // cross-origin (fonts): network-first, cache fallback
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.type !== 'error') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
