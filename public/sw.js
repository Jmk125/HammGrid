// App-shell cache only (HTML/CSS/JS/vendor). Sheet/thumbnail/markup data is
// deliberately NOT handled here - it lives in IndexedDB/OPFS (see
// js/offline-store.js) so it can be queried structurally and isn't subject
// to the opaque HTTP cache eviction CLAUDE.md warns about. This worker's job
// is only "make the app itself installable and load with no network."

const CACHE_NAME = 'app-shell-v1';

const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/project.html',
  '/viewer.html',
  '/sheet.html',
  '/documents.html',
  '/css/style.css',
  '/js/api.js',
  '/js/login.js',
  '/js/dashboard.js',
  '/js/project.js',
  '/js/viewer.js',
  '/js/sheet.js',
  '/js/markups.js',
  '/js/documents.js',
  '/js/offline-store.js',
  '/js/pwa.js',
  '/vendor/pdfjs/pdf.min.mjs',
  '/vendor/pdfjs/pdf.worker.min.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return; // let the browser handle it normally
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
