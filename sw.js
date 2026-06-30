const CACHE_NAME = 'ipsmetrix-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/chart.js',
  '/manifest.json'
];

// Install: pré-cache dos assets estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// Fetch: Cache-first para assets, Network-first para /cmd (comunicação ESP32)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Nunca intercepta chamadas para o ESP32 (/cmd, /data, etc.)
  if (url.pathname.startsWith('/cmd') || url.pathname.startsWith('/data') || url.pathname.startsWith('/limpar')) {
    return; // Passa direto para a rede
  }

  // Ignora requisições cross-origin (Google Fonts, etc.)
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate para os assets da UI
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || networkFetch;
    }).catch(() => caches.match('/index.html'))
  );
});
