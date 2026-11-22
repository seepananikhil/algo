// AlgoNeo Scalper PWA Service Worker
self.addEventListener("install", (e) => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => clients.claim())
  )
})

self.addEventListener("fetch", (e) => {
  // Let network handle all trading API requests directly
  return
})
