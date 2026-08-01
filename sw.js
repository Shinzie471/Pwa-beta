const CACHE_NAME = 'pwa-cache-v1';
const ASSETS = [
  'index.html',
  'manifest.json'
];

// Install and cache foundational files
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Activate worker and clean up old caches
self.addEventListener('activate', (e) => {
  console.log('Service Worker Activated');
});

// Fetch data from cache first, then network
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
