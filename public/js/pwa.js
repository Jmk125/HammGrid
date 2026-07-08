import { requestPersistentStorage } from '/js/offline-store.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed', err));
  });
}

requestPersistentStorage().catch((err) => console.error('Persistent storage request failed', err));
