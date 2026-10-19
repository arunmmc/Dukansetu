const CACHE = 'dukaan-setu-shell-v1';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/','/manifest.webmanifest']))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).then(response => {
    const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(request,copy)); return response;
  }).catch(async () => (await caches.match(request)) || (request.mode==='navigate' ? caches.match('/') : undefined)));
});
