/* Offline cache. Bump CACHE when any listed file changes. */
const CACHE = 'captioner-v13';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=13',
  './fonts.css?v=13',
  './store.js?v=13',
  './autocut.js?v=13',
  './copy.js?v=13',
  './captions-engine.js?v=13',
  './mp4-export.js?v=13',
  './app.js?v=13',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-512.png',
  './fonts/anton-400-latin.woff2',
  './fonts/anton-400-latin-ext.woff2',
  './fonts/archivo-black-400-latin.woff2',
  './fonts/archivo-black-400-latin-ext.woff2',
  './fonts/oswald-500-latin.woff2',
  './fonts/oswald-500-latin-ext.woff2',
  './fonts/space-grotesk-400-latin.woff2',
  './fonts/space-grotesk-400-latin-ext.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; one 404 would leave the app with no cache at all.
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Navigations: network first so a deploy lands promptly, cache as the fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return r; })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Everything else is versioned by filename or ?v=, so cache first is safe.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }))
  );
});
