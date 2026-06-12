const CACHE_NAME = 'groundlink-v8';
const ASSETS = [
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css',
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only cache heavy Mapbox files. Always pull fresh HTML/JS from the network.
  if (e.request.url.includes('mapbox')) {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
  } else {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
