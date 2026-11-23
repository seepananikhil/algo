// AlgoNeo Scalper PWA Service Worker
const CACHE_NAME = "algoneo-scalper-v2"
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.svg",
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) {
            return caches.delete(k)
          }
        })
      )
    ).then(() => clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  const url = new URL(req.url)

  // 1. Never intercept or cache non-GET requests or backend API / WebSocket calls
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) {
    return
  }

  // 2. Navigation requests: Network-first with cache fallback to /index.html (essential for SPA PWA)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", clone)).catch(() => {})
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME)
          const cachedIndex = await cache.match("/index.html")
          return cachedIndex || Response.error()
        })
    )
    return
  }

  // 3. Static assets (/assets/, icons, manifest): Network-first with cache fallback and update
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/assets/") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".json") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css"))
  ) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {})
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME)
          const cachedResp = await cache.match(req)
          return cachedResp || Response.error()
        })
    )
    return
  }
})
