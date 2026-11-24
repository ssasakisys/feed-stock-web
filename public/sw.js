// Feed Stock Gauge Service Worker（オフライン対応・アプリシェルのキャッシュ）
const CACHE_NAME = "fsg-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function shouldCache(request, url) {
  if (request.mode === "navigate") return true;
  if (url.pathname.startsWith("/_next/static/")) return true;
  const dest = request.destination;
  if (dest === "image" || dest === "style" || dest === "script") return true;
  return /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase 等は素通し

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        if (res.ok && shouldCache(request, url)) {
          const copy = res.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, copy);
          } catch (e) { /* キャッシュ失敗は無視 */ }
        }
        return res;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === "navigate") {
          const root = await cache.match("/", { ignoreSearch: true });
          if (root) return root;
        }
        throw err;
      }
    })()
  );
});
