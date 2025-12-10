/**
 * Service Worker for caching Range requests to Open-Meteo S3
 *
 * Cache strategy:
 * - Past data (validTime < now): cache 30 days (immutable reanalysis)
 * - Future data (forecasts): cache 1 hour (updated with new model runs)
 * - Cache key: path + range bytes
 */

const CACHE_NAME = 'om-ranges-v1';
const S3_HOST = 'openmeteo.s3.amazonaws.com';
const PAST_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days in ms
const FUTURE_MAX_AGE = 3600 * 1000; // 1 hour in ms

// Take control immediately on install/activate
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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

  event.respondWith(handleRangeRequest(event.request, url, rangeHeader));
});

async function handleRangeRequest(request, url, rangeHeader) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = buildCacheKey(url, rangeHeader);
  const validTime = parseValidTime(url);

  // Check cache
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse && isEntryValid(cachedResponse, validTime)) {
    console.log('[SW] Cache HIT:', cacheKey.slice(-50));
    return cachedResponse;
  }

  // Fetch from network
  console.log('[SW] Cache MISS:', cacheKey.slice(-50));
  const networkResponse = await fetch(request);

  if (networkResponse.ok || networkResponse.status === 206) {
    // Clone and convert to 200 for caching (Cache API doesn't accept 206)
    const headers = new Headers(networkResponse.headers);
    headers.set('x-cached-at', Date.now().toString());
    headers.set('x-original-status', networkResponse.status.toString());

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

  if (type === 'CLEAR_CACHE') {
    const deleted = await caches.delete(CACHE_NAME);
    event.ports[0].postMessage({ success: deleted });
  }

  if (type === 'GET_CACHE_STATS') {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let totalSize = 0;

    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        totalSize += blob.size;
      }
    }

    event.ports[0].postMessage({
      entries: keys.length,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    });
  }

  if (type === 'CLEAR_OLDER_THAN') {
    const { days } = event.data;
    const cutoff = Date.now() - (days * 24 * 3600 * 1000);
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let deleted = 0;

    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const cachedAt = parseInt(response.headers.get('x-cached-at') || '0');
        if (cachedAt < cutoff) {
          await cache.delete(request);
          deleted++;
        }
      }
    }

    event.ports[0].postMessage({ deleted });
  }
});
