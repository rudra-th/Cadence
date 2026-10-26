/**
 * Cadence service worker
 *
 * Strategy
 *  • The whole app is precached on install → it opens instantly and works
 *    with no network at all. Both pages are in the shell: the landing page
 *    and the workspace.
 *  • Navigations: network-first with a cache fallback, so a fresh build is
 *    picked up when online but the app still opens offline. A navigation
 *    that fails falls back to the page it asked for, then to the landing
 *    page — never to a blank screen.
 *  • Static assets: cache-first with background revalidation (stale-while-
 *    revalidate) — instant loads, quiet updates. The same runtime path
 *    covers the PDF-export vendor libs (html2canvas, jsPDF) below: they are
 *    ~565 KB and only needed when a user actually exports a PDF, so they
 *    are not precached — planpage.js loads them on demand, and the first
 *    export puts them in the runtime cache, offline after that.
 */

const VERSION = 'v1.6.0';
// VERSION must be bumped on every deploy — assets are not URL-versioned.
const CACHE = `cadence-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './clock.html',
  './plan.html',
  './app.html',
  './manifest.webmanifest',
  './favicon.svg',
  './assets/css/styles.css',
  './assets/css/landing-experience.css',
  './assets/js/landing-experience.js',
  './assets/vendor/lenis.min.js',
  './assets/fonts/instrument-serif-latin.woff2',
  './assets/fonts/instrument-serif-italic-latin.woff2',
  './assets/js/clock.js',
  './assets/js/planpage.js',
  './assets/js/runtime.js',
  './assets/js/timetable-import.js',
  './assets/js/printplan.js',
  './assets/js/store.js',
  './assets/js/plan.js',
  './assets/js/theme.js',
  './assets/js/util.js',
  './assets/js/audio.js',
  './assets/js/pdf.js',
  './assets/js/timetable.js',
  // Not precached: the PDF-export vendor libs (~565 KB together) load on
  // demand from planpage.js and land in the runtime cache on first use.
  './assets/fonts/inter-latin.woff2',
  './assets/fonts/inter-latin-ext.woff2',
  './assets/fonts/jetbrains-mono-latin.woff2',
  './assets/fonts/jetbrains-mono-latin-ext.woff2',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails the whole install if one entry 404s — be forgiving.
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] precache miss', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('cadence-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations → network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const shell = async () => {
        // The page that was asked for first, then the landing page.
        const direct = await cache.match(req, { ignoreSearch: true });
        if (direct) return direct;
        const app = await cache.match('./app.html');
        if (app && url.pathname.includes('app')) return app;
        return (await cache.match('./index.html')) || (await cache.match('./')) || null;
      };
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          try { await cache.put(req, fresh.clone()); } catch { /* quota */ }
          return fresh;
        }
        // A gateway error or a 404 is not a better answer than the shell
        // that is already on the device.
        const fallback = await shell();
        return fallback || fresh;
      } catch {
        const fallback = await shell();
        return fallback || Response.error();
      }
    })());
    return;
  }

  // Everything else → cache first, revalidate in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req).then(async (res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        try { await cache.put(req, res.clone()); } catch { /* quota */ }
      }
      return res;
    }).catch(() => null);

    if (hit) {
      event.waitUntil(network);
      return hit;
    }

    const res = await network;
    if (res) return res;

    return new Response('Offline and not cached.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  })());
});

/* ── Notifications ───────────────────────────────────────── */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './clock.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes(self.registration.scope) && 'focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
