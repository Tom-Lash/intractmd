// IntractMD™ Service Worker
// Resolve Medical, LLC — © 2026
const CACHE_VERSION = 'intractmd-v1';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const DYNAMIC_CACHE = CACHE_VERSION + '-dynamic';

// Files to pre-cache on install
const PRECACHE_URLS = [
  '/app',
  '/login',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

// Install — pre-cache shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('intractmd-') && k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Static shell (/app, /login, icons, manifest) → cache-first
// - API calls (/api/*) → network-only (never cache clinical data)
// - Surface pages (/proactive, /clinical, /deprescribing) → network-first with cache fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept non-GET or cross-origin requests
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // API calls — always network, never cache
  if (url.pathname.startsWith('/api/')) return;

  // Static assets — cache first
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/app' ||
    url.pathname === '/login'
  ) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(c => c.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Surface pages and everything else — network first, cache fallback
  event.respondWith(
    fetch(event.request).then(response => {
      // Cache successful HTML responses
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const clone = response.clone();
        caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request).then(cached => {
        if (cached) return cached;
        // Offline fallback
        return caches.match('/app');
      });
    })
  );
});
