// Stale PWA cache auto-evict
try {
  if (typeof caches !== 'undefined') {
    caches.keys().then(function(k) { return Promise.all(k.map(function(n) { return caches.delete(n); })); });
  }
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(r) { return Promise.all(r.map(function(sw) { return sw.unregister(); })); });
  }
} catch(e) {}
setTimeout(function() {
  window.location.href = '/scalp?v=' + Date.now();
}, 100);
export const ManualTradingPage = function() { return null; };
export default ManualTradingPage;
