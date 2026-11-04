// Offline app shell (QR-01). Cache-first for the shell; the API is never cached.
const CACHE = "stemmate-v1.3";
const SHELL = ["/", "/style.css", "/manifest.webmanifest", "/src/ui.js", "/src/core.js", "/src/store.js", "/src/sync.js", "/data/catalogue.json", "/data/labels.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/")) return;
  // network first so content edits arrive when online, cache as the offline fallback
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("/"))));
});
