// AlgoNeo Scalper PWA Service Worker
self.addEventListener("install", (e) => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim())
})

self.addEventListener("fetch", (e) => {
  // Let network handle all trading API requests directly
  return
})
