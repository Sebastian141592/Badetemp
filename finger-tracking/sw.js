// Service worker — makes Finger-Tracking installable and work offline once
// loaded, so it can run full-screen from the home screen (outside the browser UI).

const CACHE = "ft-v5";

// index.html is fully self-contained (CSS, JS, icons + manifest inlined), so the
// app shell is a single file. The cross-origin MediaPipe model/WASM is cached at
// runtime below.
const ASSETS = ["./index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first with network fallback; runtime-cache new GETs (incl. the
// cross-origin MediaPipe model + WASM, stored as opaque responses).
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
