/* Service worker: statické soubory z cache (rychlý start, offline UI),
   stránky network-first s offline fallbackem, API vždy ze sítě. */
const CACHE = "gmaps-historie-__VERSION__";   // dosazuje server při vydání
const STATIC_ASSETS = [
  "/", "/kniha",
  "/static/style.css", "/static/kniha.css",
  "/static/common.js", "/static/app.js", "/static/kniha.js", "/static/icons.js",
  "/static/charts.js", "/static/places-ui.js", "/static/map-tools.js",
  "/static/map-filters.js", "/static/sync-events.js", "/static/day-playback.js",
  "/static/import-ui.js", "/static/timelapse.js", "/static/year-card.js",
  "/static/vendor/leaflet.js", "/static/vendor/leaflet.css",
  "/static/vendor/leaflet-heat.js", "/static/vendor/leaflet.markercluster.js",
  "/static/vendor/MarkerCluster.css", "/static/vendor/MarkerCluster.Default.css",
  "/static/vendor/protomaps-leaflet.js", "/static/vendor/glify-browser.js",
  "/static/icon.svg", "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;   // data vždy čerstvá

  if (url.pathname.startsWith("/static/")) {
    // statika: cache-first (verzuje se názvem CACHE při vydání)
    e.respondWith(caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })));
    return;
  }
  // stránky: network-first, při výpadku poslední známá verze
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
