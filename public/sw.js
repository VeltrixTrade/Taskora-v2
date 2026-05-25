const CACHE_NAME = "taskora-v10-cache";
const ASSETS = [
  "/manifest.json",
  "/assets/taskora-icon.png",
  "/assets/taskora-app-icon-192.png",
  "/assets/taskora-app-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate" || req.destination === "document") return;
  event.respondWith(
    fetch(req).then(res => {
      if (!res || !res.ok || res.type !== "basic") return res;
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) return res;
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => null);
      return res;
    }).catch(() => caches.match(req))
  );
});
