// Service worker for the GDA-58 spike. Throw-away test code, not the real app.
// Keeps a copy of every site file so the page opens with no signal (W7),
// and waits to be told before replacing an older version (W8).

importScripts("./version.js"); // sets self.SPIKE_VERSION

// Every project site on this host shares one origin, so caches are shared too.
// The prefix means we only ever touch caches that belong to this spike.
const CACHE_PREFIX = "gameday-spike-";
const CACHE_NAME = CACHE_PREFIX + self.SPIKE_VERSION;

const SITE_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./version.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-512.png",
];

// The folder this worker looks after, e.g. /gameday-app-test/
const SCOPE_PATH = new URL("./", self.location).pathname;

self.addEventListener("install", (event) => {
  // No skipWaiting here on purpose: a new version waits until the page asks.
  // cache: "reload" skips the browser's normal file cache. Without it a new
  // version could store old files, because GitHub Pages lets browsers reuse
  // files for 10 minutes.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SITE_FILES.map((file) => new Request(file, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const oldNames = names.filter(
        (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
      );
      await Promise.all(oldNames.map((name) => caches.delete(name)));
      // Lets the very first install control the page without a second open.
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Leave everything else alone, including the Google Sheet calls.
  const isOurs =
    request.method === "GET" &&
    url.origin === self.location.origin &&
    url.pathname.startsWith(SCOPE_PATH);
  if (!isOurs) {
    return;
  }

  event.respondWith(
    (async () => {
      // Look only in this version's cache, so a waiting version's files
      // can never leak into the running page.
      const cache = await caches.open(CACHE_NAME);
      const options = { ignoreSearch: true, ignoreVary: true };
      const cached = await cache.match(request, options);
      if (cached) {
        return cached;
      }
      if (request.mode === "navigate") {
        const page = await cache.match("./index.html", options);
        if (page) {
          return page;
        }
      }
      return fetch(request);
    })()
  );
});
