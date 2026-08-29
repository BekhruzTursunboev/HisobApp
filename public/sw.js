// Service worker — the thing that makes this installable and makes it work
// on the metro with no signal.
//
// Three routing rules, in order:
//   /api/*      network only. Spending data must never be served stale.
//   navigation  network first, fall back to the cached shell when offline.
//   everything  cache first, refresh in the background.
//
// Bump VERSION whenever the shell changes; old caches are dropped on activate.

const VERSION = "v3";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // addAll fails the whole install if any one URL 404s, so add
      // individually and let the shell come up even if an icon is missing
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. API — never cached. Offline gets a shaped error the client already handles.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: { code: "offline", message: "No connection." } }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          })
      )
    );
    return;
  }

  // 2. Navigations — fresh when possible, the cached shell when not.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // 3. Everything else — serve from cache, refresh behind the scenes.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          // opaque cross-origin responses (Google Fonts) are cacheable but
          // unreadable; storing them is still what makes fonts work offline
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
