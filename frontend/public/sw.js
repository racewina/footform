// FootForm service worker — deliberately conservative so it never serves stale
// content while online:
//   • navigations (HTML) → network-first, fall back to cached shell only offline
//   • /api/*             → network-first, fall back to last response only offline
//   • /assets/* (hashed) → cache-first (those files are immutable per build)
//   • cross-origin (team logos, an absolute API) → left alone
// Bumping CACHE on each meaningful change drops the old cache on activate.
const CACHE = "footform-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't intercept cross-origin

  // App shell / navigations: always try the network, cache the shell for offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/", net.clone());
          return net;
        } catch {
          return (await caches.match("/")) || (await caches.match(req)) || Response.error();
        }
      })()
    );
    return;
  }

  // API: fresh when online, last-known when offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, net.clone());
          return net;
        } catch {
          return (await caches.match(req)) || Response.error();
        }
      })()
    );
    return;
  }

  // Immutable hashed build assets: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const net = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, net.clone());
        return net;
      })()
    );
  }
  // Everything else (icons, manifest, favicon) uses the default network behaviour.
});
