// Offline support: cache the app and its data. Map tiles are left to the browser's normal cache.
const CACHE = 'dsr-v4';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/graph.js', 'js/reports.js', 'js/i18n.js', 'js/search.js',
  'data/area.json', 'fonts/anek-bangla.woff2',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // tiles etc.: network as usual
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit || caches.match('index.html'));
    return hit || net;     // cached copy now, fresh copy for next time
  }));
});
