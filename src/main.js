import { App } from './core/App.js';

window.app = new App(document.body);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then((reg) => {
        // Pull a fresh SW on every load so Pages deploys aren't stuck behind
        // a cache-first shell from a previous visit.
        reg.update().catch(() => {});
        setInterval(() => reg.update().catch(() => {}), 60_000);
      })
      .catch((err) => console.warn('SW registration failed', err));

    // One automatic reload when a new SW claims the page (first update only).
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}
