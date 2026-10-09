import { requestPersistentStorage } from '/js/offline-store.js';
import { startPhotoOutbox } from '/js/photoOutbox.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed', err));
  });
}

requestPersistentStorage().catch((err) => console.error('Persistent storage request failed', err));

// Uploads any photo-pin photos taken while offline, on every page (not just
// the sheet viewer), so they go up the first time HammGrid is open with a
// connection again - see photoOutbox.js.
startPhotoOutbox();
