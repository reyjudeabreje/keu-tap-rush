const CACHE_NAME = "keu-tap-rush-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.webmanifest",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode !== "navigate" && !APP_SHELL.includes(new URL(event.request.url).pathname)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && event.request.mode === "navigate") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
      }
      return response;
    }).catch(() => event.request.mode === "navigate" ? caches.match("/index.html") : Response.error()))
  );
});