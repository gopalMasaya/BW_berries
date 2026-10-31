// sw.js — instant start for the main dashboard (index.html) only.
//
// Without this, every visit waited 0.3–2 s for index.html from the hosting CDN,
// and on a dark-mode OS Chrome shows an empty BLACK page meanwhile. The worker
// answers navigations to "/" and "/index.html" from a cached copy at once and
// refreshes that copy from the network in the background (stale-while-revalidate).
//
// Freshness after a deploy: if the fresh copy differs (ETag) from the one just
// served, the page is told ("shell-updated"); index.html reloads itself if it is
// still on its loading splash, otherwise the new version is used on the next visit.
//
// Only these navigations are touched — every other request (API, Firebase,
// scripts, other pages) goes straight to the network as before.
const CACHE = "pt-shell-v1";
const SHELL_PATHS = ["/", "/index.html"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !SHELL_PATHS.includes(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match("/index.html");
    const network = fetch("/index.html", { cache: "no-cache", credentials: "same-origin" })
      .then(async (res) => {
        if (res.ok && res.status === 200){
          await cache.put("/index.html", res.clone());
          const oldTag = cached && cached.headers.get("etag");
          const newTag = res.headers.get("etag");
          if (cached && oldTag && newTag && oldTag !== newTag){
            const client = e.resultingClientId && await self.clients.get(e.resultingClientId);
            if (client) client.postMessage({ type: "shell-updated" });
          }
        }
        return res;
      });
    if (cached){
      e.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;   // first visit (nothing cached yet): plain network
  })());
});
