// ネットワーク優先 + フォールバックキャッシュ
// HTML/CSS/JSは常に最新を取りに行き、オフライン時のみキャッシュを返す
const CACHE_NAME = "okozukai-v30";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./tyokinbako.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
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

// メッセージ経由での即時アクティベート
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  // HTML/CSS/JS/JSON はネットワーク優先で常に最新を取得
  const isCodeFile = e.request.mode === "navigate"
    || /\.(html|css|js|json)$/i.test(url.pathname);

  if (isCodeFile) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // 画像など静的資産はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
