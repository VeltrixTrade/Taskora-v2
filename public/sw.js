const CACHE_VERSION = "v12.7-cache-deploy-fix";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() => fetch("/")));
    return;
  }
  event.respondWith(fetch(req, { cache: "no-store" }).catch(() => caches.match(req)));
});
