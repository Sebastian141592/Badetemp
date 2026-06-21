// Service worker — makes Finger-Tracking installable and work offline once
// loaded, so it can run full-screen from the home screen (outside the browser UI).

const CACHE = "ft-v2";

// Same-origin app shell to pre-cache. (No bare "./" — some static hosts don't
// serve a directory index, which would make install fail.)
const ASSETS = [
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/euro.js",
  "./js/gestures.js",
  "./js/bridge.js",
  "./js/game.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

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
