// AlgoNeo Scalper Service Worker - Clean Self-Unregister & Cache Purge
// Kotak Neo live scalping terminal operates natively via HTTP with zero SW interceptor bottlenecks
self.addEventListener("install", (e) => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
      .catch(() => {})
  )
})
