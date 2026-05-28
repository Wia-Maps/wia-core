/* Service Worker: offline-first shell + bounded MapLibre raster tile caching */
const SW_VERSION = 'wia-v11';
const STATIC_CACHE = `${SW_VERSION}-static`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;
const TILE_CACHE = `${SW_VERSION}-tiles`;
const DATA_CACHE = `${SW_VERSION}-data`;
const CURRENT_CACHES = new Set([STATIC_CACHE, RUNTIME_CACHE, TILE_CACHE, DATA_CACHE]);

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/notification-icon.svg',
  '/notification-badge.svg',
  '/logo.webp',
];

const MAX_RUNTIME_ENTRIES = 40;
const MAX_TILE_ENTRIES = 90;
const MAX_DATA_ENTRIES = 6;

const PREWARM_CENTER = { lat: 7.1688, lng: 5.5892 };
const PREWARM_ZOOMS = [16, 17];
const PREWARM_RADIUS = 1;

const MAP_TILE_HOST_PATTERNS = [
  /\.basemaps\.cartocdn\.com$/i,
  /\.tile\.openstreetmap\.org$/i,
];

const isCacheableResponse = (response) => {
  return Boolean(response) && (response.ok || response.type === 'opaque');
};

const trimCache = async (cacheName, maxEntries) => {
  const cache = await caches.open(cacheName);
  const requests = await cache.keys();

  if (requests.length <= maxEntries) {
    return;
  }

  const removals = requests
    .slice(0, requests.length - maxEntries)
    .map((request) => cache.delete(request));

  await Promise.all(removals);
};

const putInCache = async (cacheName, request, response, maxEntries) => {
  if (!isCacheableResponse(response)) {
    return;
  }

  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());

  if (typeof maxEntries === 'number') {
    await trimCache(cacheName, maxEntries);
  }
};

const networkFirst = async (request, cacheName, options = {}) => {
  try {
    const networkResponse = await fetch(request);
    await putInCache(cacheName, request, networkResponse, options.maxEntries);
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    if (options.fallbackUrl) {
      const fallback = await caches.match(options.fallbackUrl);
      if (fallback) {
        return fallback;
      }
    }

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
};

const staleWhileRevalidate = async (request, cacheName, options = {}) => {
  const cachedResponse = await caches.match(request);

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      await putInCache(cacheName, request, networkResponse, options.maxEntries);
      return networkResponse;
    })
    .catch(() => undefined);

  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) {
    return networkResponse;
  }

  return new Response('Offline', { status: 503, statusText: 'Offline' });
};

const cacheFirst = async (request, cacheName, options = {}) => {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    await putInCache(cacheName, request, networkResponse, options.maxEntries);
    return networkResponse;
  } catch {
    return new Response('', { status: 204, statusText: 'No cached resource' });
  }
};

const toTileX = (lng, zoom) => {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
};

const toTileY = (lat, zoom) => {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
};

const buildPrewarmTileUrls = () => {
  const urls = [];

  PREWARM_ZOOMS.forEach((zoom) => {
    const centerX = toTileX(PREWARM_CENTER.lng, zoom);
    const centerY = toTileY(PREWARM_CENTER.lat, zoom);

    for (let dx = -PREWARM_RADIUS; dx <= PREWARM_RADIUS; dx += 1) {
      for (let dy = -PREWARM_RADIUS; dy <= PREWARM_RADIUS; dy += 1) {
        const x = centerX + dx;
        const y = centerY + dy;
        urls.push(`https://a.basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${x}/${y}.png`);
      }
    }
  });

  return urls;
};

let tilePrewarmPromise = null;

const prewarmCampusTiles = async () => {
  const cache = await caches.open(TILE_CACHE);
  const urls = buildPrewarmTileUrls();

  const concurrency = 3;
  let index = 0;

  const worker = async () => {
    while (index < urls.length) {
      const url = urls[index];
      index += 1;

      try {
        const response = await fetch(url, { mode: 'no-cors' });
        if (isCacheableResponse(response)) {
          await cache.put(url, response.clone());
        }
      } catch {
        // Ignore prewarm failures.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  await trimCache(TILE_CACHE, MAX_TILE_ENTRIES);
};

const isNavigationRequest = (request) => request.mode === 'navigate';

const isMapDatasetRequest = (url) => {
  if (url.origin !== self.location.origin) {
    return false;
  }

  return url.pathname === '/api/v1/map/geojson' || url.pathname === '/api/v1/map/routing';
};

const isStaticAssetRequest = (request, url) => {
  if (url.origin !== self.location.origin) {
    return false;
  }

  if (url.pathname.startsWith('/assets/')) {
    return true;
  }

  return ['script', 'style', 'font', 'worker'].includes(request.destination);
};

const isMapTileRequest = (request, url) => {
  if (request.destination !== 'image') {
    return false;
  }

  if (url.origin === self.location.origin) {
    return /\/tiles?\//i.test(url.pathname);
  }

  return (
    MAP_TILE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname)) ||
    /\/rastertiles\//i.test(url.pathname)
  );
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.allSettled(
        APP_SHELL_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // Ignore individual shell caching failures.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      // Keep only current-version caches. Remove every previous/legacy cache bucket.
      await Promise.all(
        cacheNames
          .filter((cacheName) => !CURRENT_CACHES.has(cacheName))
          .map((cacheName) => caches.delete(cacheName))
      );

      // Enforce strict cache caps immediately on activation.
      await trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
      await trimCache(TILE_CACHE, MAX_TILE_ENTRIES);
      await trimCache(DATA_CACHE, MAX_DATA_ENTRIES);

      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'PREWARM_TILES') {
    if (!tilePrewarmPromise) {
      tilePrewarmPromise = prewarmCampusTiles().catch(() => undefined);
    }

    event.waitUntil(tilePrewarmPromise);
  }

  if (event.data?.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (isNavigationRequest(request)) {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE, {
        maxEntries: MAX_RUNTIME_ENTRIES,
        fallbackUrl: '/index.html',
      })
    );
    return;
  }

  if (isMapTileRequest(request, url)) {
    event.respondWith(
      cacheFirst(request, TILE_CACHE, {
        maxEntries: MAX_TILE_ENTRIES,
      })
    );
    return;
  }

  if (isMapDatasetRequest(url)) {
    event.respondWith(
      networkFirst(request, DATA_CACHE, {
        maxEntries: MAX_DATA_ENTRIES,
      })
    );
    return;
  }

  if (isStaticAssetRequest(request, url)) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE, {
        maxEntries: MAX_RUNTIME_ENTRIES,
      })
    );
    return;
  }

  // Do not cache arbitrary third-party requests.
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    networkFirst(request, RUNTIME_CACHE, {
      maxEntries: MAX_RUNTIME_ENTRIES,
      fallbackUrl: '/index.html',
    })
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  const payload = event.data.json();
  const payloadData = payload?.data || payload;
  const title = payloadData?.title || payload?.notification?.title || 'Wia update';
  const options = {
    body:
      payloadData?.body ||
      payload?.notification?.body ||
      'A campus location you follow has a new update.',
    icon: payloadData?.icon || '/logo.webp',
    badge: payloadData?.badge || '/logo.webp',
    tag: payloadData?.tag || 'wia-location-update',
    data: {
      url: payloadData?.url || '/',
      locationId: payloadData?.locationId || null,
      module: payloadData?.module || null,
    },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const target = new URL(notificationData.url || '/', self.location.origin);

  if (notificationData.locationId) {
    target.searchParams.set('location', notificationData.locationId);
    target.searchParams.set('source', 'notification');
  }

  const targetUrl = target.toString();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const matchingClient = clients.find((client) => client.url.startsWith(self.location.origin));

      if (matchingClient) {
        return matchingClient.navigate(targetUrl).then((client) => client?.focus());
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
