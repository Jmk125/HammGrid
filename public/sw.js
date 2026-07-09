// App-shell cache only (HTML/CSS/JS/vendor). Sheet/thumbnail/markup data is
// deliberately NOT handled here - it lives in IndexedDB/OPFS (see
// js/offline-store.js) so it can be queried structurally and isn't subject
// to the opaque HTTP cache eviction CLAUDE.md warns about. This worker's job
// is only "make the app itself installable and load with no network."

// Bump this on every deploy that changes any precached file. It's the only
// thing that forces already-visited browsers to drop a stale cache - see
// the fetch handler below for why that alone used to not be enough. Also
// note install() below fails closed: cache.addAll() rejects the whole
// install if ANY url here 404s (e.g. a renamed/deleted page), so keep this
// list in sync with public/ or the service worker stops updating entirely.
const CACHE_NAME = 'app-shell-v4';

const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/viewer.html',
  '/sheet.html',
  '/documents.html',
  '/shares.html',
  '/activity.html',
  '/project-settings.html',
  '/document-view.html',
  '/css/style.css',
  '/js/api.js',
  '/js/login.js',
  '/js/dashboard.js',
  '/js/shell.js',
  '/js/viewer.js',
  '/js/sheet.js',
  '/js/markups.js',
  '/js/documents.js',
  '/js/offline-store.js',
  '/js/pwa.js',
  '/js/shares.js',
  '/js/activity.js',
  '/js/project-settings.js',
  '/js/document-view.js',
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

// Network-first, cache as the offline fallback - NOT cache-first. This is an
// actively-developed app; cache-first silently froze already-visited
// browsers on whatever HTML/JS existed at first-visit time, since nothing
// here has content-hashed filenames to bust on change. Every successful
// online fetch refreshes the cache, so the offline fallback still stays
// reasonably current.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return; // let the browser handle it normally
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
