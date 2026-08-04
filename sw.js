const CACHE_NAME = 'jdl-inventory-v1';
const ASSETS = [
  'index.html',
  'manifest.json'
];

// Install stage: cache critical files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Activate stage: clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activated');
});

// Fetch stage: mandatory requirement for PWA installation
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
