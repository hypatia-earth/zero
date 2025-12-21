/**
 * Service Worker for caching Range requests to Open-Meteo S3
 *
 * Cache strategy:
 * - Past data (validTime < now): cache 30 days (immutable reanalysis)
 * - Future data (forecasts): cache 1 hour (updated with new model runs)
 * - Separate cache per layer (temp, wind, rain, pressure, meta)
 * - Cache key: path + range bytes
 */

const DEBUG = false;
const CACHE_PREFIX = 'om-';
const CACHE_VERSION = 'v2';
const S3_HOST = 'openmeteo.s3.amazonaws.com';

// Log to main thread via BroadcastChannel
const logChannel = new BroadcastChannel('sw-log');
function swLog(...args) {
  console.log(...args);
  logChannel.postMessage(args.join(' '));
}
const PAST_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days in ms
const FUTURE_MAX_AGE = 7 * 24 * 3600 * 1000; // 7 days in ms (data immutable per model run)

// Valid layer names (must match TWeatherLayer + 'meta')
const VALID_LAYERS = ['temp', 'rain', 'clouds', 'humidity', 'wind', 'pressure', 'meta'];

/**
 * Get cache name for a layer
 */
function getCacheName(layer) {
  const validLayer = VALID_LAYERS.includes(layer) ? layer : 'meta';
  return `${CACHE_PREFIX}${validLayer}-${CACHE_VERSION}`;
}

// Legacy cache name to clean up
const LEGACY_CACHE = 'om-ranges-v1';

// Take control immediately on install/activate
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean up old caches (legacy + old versions)
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => k === LEGACY_CACHE || (k.startsWith(CACHE_PREFIX) && !k.endsWith(CACHE_VERSION)))
            .map(k => {
              console.log(`[SW] Deleting old cache: ${k}`);
              return caches.delete(k);
            })
        )
      )
    ])
  );
  console.log('[SW] Activated and claiming clients');
});

/**
 * Extract valid time from URL path
 * e.g., /data_spatial/ecmwf_ifs/2025/12/08/1200Z/2025-12-08T1400.om → Date
 */
function parseValidTime(url) {
  const match = url.pathname.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})?\.om$/);
  if (!match) return null;

  const [, year, month, day, hour, minute = '00'] = match;
  return new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute)
  ));
}

/**
 * Build cache key from URL and Range header
 * Uses a fake URL scheme so Cache API can match it properly
 */
function buildCacheKey(url, rangeHeader) {
  // Extract path after host: /data_spatial/ecmwf_ifs/...
  const path = url.pathname;
  // Range: bytes=0-65535 → 0-65535
  const range = rangeHeader.replace('bytes=', '');
  // Use a fake URL so Cache API can match it
  return `https://om-cache${path}?range=${range}`;
}

/**
 * Check if cached entry is still valid
 */
function isEntryValid(cachedResponse, validTime) {
  const cachedAt = cachedResponse.headers.get('x-cached-at');
  if (!cachedAt) return false;

  const age = Date.now() - parseInt(cachedAt);
  const isPast = validTime && validTime < Date.now();
  const maxAge = isPast ? PAST_MAX_AGE : FUTURE_MAX_AGE;

  return age < maxAge;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const rangeHeader = event.request.headers.get('Range');

  // Only handle Range requests to S3
  if (url.host !== S3_HOST || !rangeHeader) {
    return;
  }

  // Get layer from custom header
  const layer = event.request.headers.get('X-Layer') || 'meta';

  event.respondWith(handleRangeRequest(event.request, url, rangeHeader, layer));
});

async function handleRangeRequest(request, url, rangeHeader, layer) {
  const cacheName = getCacheName(layer);
  const cache = await caches.open(cacheName);
  const cacheKey = buildCacheKey(url, rangeHeader);
  const validTime = parseValidTime(url);

  // Check cache
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    if (isEntryValid(cachedResponse, validTime)) {
      DEBUG && swLog(`[SW] HIT (${layer}):`, cacheKey.slice(-50));
      return cachedResponse;
    } else {
      const cachedAt = cachedResponse.headers.get('x-cached-at');
      const age = cachedAt ? Math.round((Date.now() - parseInt(cachedAt)) / 60000) : '?';
      DEBUG && swLog(`[SW] EXPIRED (${layer}): age=${age}min`, cacheKey.slice(-50));
    }
  }

  // Fetch from network
  DEBUG && swLog(`[SW] MISS (${layer}):`, cacheKey.slice(-50));
  const networkResponse = await fetch(request);

  if (networkResponse.ok || networkResponse.status === 206) {
    // Clone and convert to 200 for caching (Cache API doesn't accept 206)
    const headers = new Headers(networkResponse.headers);
    headers.set('x-cached-at', Date.now().toString());
    headers.set('x-original-status', networkResponse.status.toString());
    headers.set('x-layer', layer);

    const responseToCache = new Response(await networkResponse.clone().arrayBuffer(), {
      status: 200,
      statusText: 'OK',
      headers
    });

    // Store with custom key
    await cache.put(cacheKey, responseToCache);
  }

  return networkResponse;
}

// Handle messages from main thread
self.addEventListener('message', async (event) => {
  const { type } = event.data;

  // Force claim control of all clients
  if (type === 'CLAIM') {
    await self.clients.claim();
    event.ports[0].postMessage({ success: true });
    return;
  }

  if (type === 'CLEAR_CACHE') {
    // Clear all layer caches
    const keys = await caches.keys();
    const deleted = await Promise.all(
      keys.filter(k => k.startsWith(CACHE_PREFIX)).map(k => caches.delete(k))
    );
    event.ports[0].postMessage({ success: deleted.some(d => d) });
  }

  if (type === 'CLEAR_LAYER_CACHE') {
    const { layer } = event.data;
    const cacheName = getCacheName(layer);
    const deleted = await caches.delete(cacheName);
    event.ports[0].postMessage({ success: deleted, layer });
  }

  if (type === 'GET_CACHE_STATS') {
    const keys = await caches.keys();
    const layerCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    const stats = { layers: {}, totalEntries: 0, totalSizeMB: 0 };

    for (const cacheName of layerCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      let layerSize = 0;

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          const blob = await response.blob();
          layerSize += blob.size;
        }
      }

      // Extract layer name from cache name: om-temp-v2 → temp
      const layerName = cacheName.replace(CACHE_PREFIX, '').replace(`-${CACHE_VERSION}`, '');
      stats.layers[layerName] = {
        entries: requests.length,
        sizeMB: (layerSize / (1024 * 1024)).toFixed(2)
      };
      stats.totalEntries += requests.length;
      stats.totalSizeMB += layerSize / (1024 * 1024);
    }

    stats.totalSizeMB = stats.totalSizeMB.toFixed(2);
    event.ports[0].postMessage(stats);
  }

  if (type === 'GET_LAYER_STATS') {
    const { layer } = event.data;
    const cacheName = getCacheName(layer);
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    let totalSize = 0;
    const entries = [];

    for (const request of requests) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        const cachedAt = response.headers.get('x-cached-at');
        entries.push({
          url: request.url,
          sizeMB: (blob.size / (1024 * 1024)).toFixed(3),
          cachedAt: cachedAt ? new Date(parseInt(cachedAt)).toISOString() : null
        });
        totalSize += blob.size;
      }
    }

    event.ports[0].postMessage({
      layer,
      entries: entries.length,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      items: entries
    });
  }

  if (type === 'CLEAR_OLDER_THAN') {
    const { days } = event.data;
    const cutoff = Date.now() - (days * 24 * 3600 * 1000);
    const keys = await caches.keys();
    const layerCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    let deleted = 0;

    for (const cacheName of layerCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          const cachedAt = parseInt(response.headers.get('x-cached-at') || '0');
          if (cachedAt < cutoff) {
            await cache.delete(request);
            deleted++;
          }
        }
      }
    }

    event.ports[0].postMessage({ deleted });
  }
});
