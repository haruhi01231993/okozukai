// シンプルなオフラインキャッシュ
const CACHE_NAME = "okozukai-v13";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 同一オリジンのみキャッシュ。Google API などはネットワーク優先。
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request).then(r => {
      // 成功したら更新キャッシュへ
      if (r.ok && e.request.method === "GET") {
        const copy = r.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => res))
  );
});
