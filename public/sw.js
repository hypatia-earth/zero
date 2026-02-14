/**
 * Service Worker for caching Range requests to Open-Meteo S3
 *
 * Cache strategy:
 * - Past data (validTime < now): cache 30 days (immutable reanalysis)
 * - Future data (forecasts): cache 1 hour (updated with new model runs)
 * - Separate cache per param (temperature_2m, wind_u_component_10m, etc.)
 * - Cache key: path + range bytes
 */

const DEBUG = false;
const CACHE_PREFIX = 'om-';
const CACHE_VERSION = 'v3';  // Bumped for param-based caching
const S3_HOST = 'openmeteo.s3.amazonaws.com';

// Log to main thread via BroadcastChannel
const logChannel = new BroadcastChannel('sw-log');
function swLog(...args) {
  console.log(...args);
  logChannel.postMessage(args.join(' '));
}
const PAST_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days in ms
const FUTURE_MAX_AGE = 7 * 24 * 3600 * 1000; // 7 days in ms (data immutable per model run)

// Valid param names for caching
const VALID_PARAMS = [
  'temperature_2m',
  'precipitation_type',
  'cloud_cover',
  'wind_u_component_10m',
  'wind_v_component_10m',
  'pressure_msl',
  'meta',
];

/**
 * Get cache name for a param
 */
function getCacheName(param) {
  const validParam = VALID_PARAMS.includes(param) ? param : 'meta';
  return `${CACHE_PREFIX}${validParam}-${CACHE_VERSION}`;
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

  // Get param from custom header
  const param = event.request.headers.get('X-Param') || 'meta';

  event.respondWith(handleRangeRequest(event.request, url, rangeHeader, param));
});

async function handleRangeRequest(request, url, rangeHeader, param) {
  const cacheName = getCacheName(param);
  const cache = await caches.open(cacheName);
  const cacheKey = buildCacheKey(url, rangeHeader);
  const validTime = parseValidTime(url);

  // Check cache
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    if (isEntryValid(cachedResponse, validTime)) {
      DEBUG && swLog(`[SW] HIT (${param}):`, cacheKey.slice(-50));
      return cachedResponse;
    } else {
      const cachedAt = cachedResponse.headers.get('x-cached-at');
      const age = cachedAt ? Math.round((Date.now() - parseInt(cachedAt)) / 60000) : '?';
      DEBUG && swLog(`[SW] EXPIRED (${param}): age=${age}min`, cacheKey.slice(-50));
    }
  }

  // Fetch from network
  DEBUG && swLog(`[SW] MISS (${param}):`, cacheKey.slice(-50));
  const networkResponse = await fetch(request);

  if (networkResponse.ok || networkResponse.status === 206) {
    // Clone and convert to 200 for caching (Cache API doesn't accept 206)
    const headers = new Headers(networkResponse.headers);
    headers.set('x-cached-at', Date.now().toString());
    headers.set('x-original-status', networkResponse.status.toString());
    headers.set('x-param', param);

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

  if (type === 'PING') {
    event.ports[0].postMessage({ ready: true });
    return;
  }

  if (type === 'CLEAR_CACHE') {
    // Clear all param caches
    const keys = await caches.keys();
    const deleted = await Promise.all(
      keys.filter(k => k.startsWith(CACHE_PREFIX)).map(k => caches.delete(k))
    );
    event.ports[0].postMessage({ success: deleted.some(d => d) });
  }

  if (type === 'CLEAR_PARAM_CACHE') {
    const { param } = event.data;
    const cacheName = getCacheName(param);
    const deleted = await caches.delete(cacheName);
    event.ports[0].postMessage({ success: deleted, param });
  }

  if (type === 'GET_CACHE_STATS') {
    const keys = await caches.keys();
    const paramCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    const stats = { params: {}, totalEntries: 0, totalSizeMB: '0' };

    for (const cacheName of paramCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      // Extract param name from cache name: om-temperature_2m-v3 → temperature_2m
      const paramName = cacheName.replace(CACHE_PREFIX, '').replace(`-${CACHE_VERSION}`, '');
      stats.params[paramName] = {
        entries: requests.length,
        sizeMB: '0'  // Skip slow blob size calc for quick stats
      };
      stats.totalEntries += requests.length;
    }

    event.ports[0].postMessage(stats);
  }

  if (type === 'GET_PARAM_STATS') {
    const { param } = event.data;
    const cacheName = getCacheName(param);
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
      param,
      entries: entries.length,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      items: entries
    });
  }

  if (type === 'CLEAR_OLDER_THAN') {
    const { days } = event.data;
    const cutoff = Date.now() - (days * 24 * 3600 * 1000);
    const keys = await caches.keys();
    const paramCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    let deleted = 0;

    for (const cacheName of paramCaches) {
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

  if (type === 'CLEAR_BEFORE_TIMESTEP') {
    const { cutoffIso } = event.data;
    const cutoff = new Date(cutoffIso);
    const keys = await caches.keys();
    const paramCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    let deleted = 0;

    for (const cacheName of paramCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        const url = new URL(request.url);
        const validTime = parseValidTime(url);
        if (validTime && validTime < cutoff) {
          await cache.delete(request);
          deleted++;
        }
      }
    }

    event.ports[0].postMessage({ deleted });
  }

  if (type === 'COUNT_BEFORE_TIMESTEP') {
    const { cutoffIso } = event.data;
    const cutoff = new Date(cutoffIso);
    const keys = await caches.keys();
    const paramCaches = keys.filter(k => k.startsWith(CACHE_PREFIX));
    let count = 0;

    for (const cacheName of paramCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        const url = new URL(request.url);
        const validTime = parseValidTime(url);
        if (validTime && validTime < cutoff) {
          count++;
        }
      }
    }

    event.ports[0].postMessage({ count });
  }

  if (type === 'SET_PREFETCH_CONFIG') {
    const { config } = event.data;
    prefetchConfig = config;
    DEBUG && console.log('[SW] Prefetch config updated:', config);
    event.ports[0].postMessage({ success: true });
  }

  if (type === 'GET_PREFETCH_HISTORY') {
    const history = await getPrefetchHistory();
    event.ports[0].postMessage(history);
  }

  if (type === 'CLEAR_PREFETCH_HISTORY') {
    try {
      const db = await openPrefetchDB();
      const tx = db.transaction(PREFETCH_STORE, 'readwrite');
      tx.objectStore(PREFETCH_STORE).clear();
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      event.ports[0].postMessage({ success: true });
    } catch (err) {
      event.ports[0].postMessage({ success: false, error: err.message });
    }
  }

  if (type === 'TRIGGER_PREFETCH') {
    // Respond immediately, run prefetch in background
    event.ports[0].postMessage({ started: true });
    handlePrefetch();
  }
});

// ============================================================
// Periodic Background Sync - Prefetching
// ============================================================

/**
 * Prefetch configuration (set by main thread)
 */
let prefetchConfig = {
  enabled: false,
  forecastDays: '2',
  layers: ['temp'],
};

// ============================================================
// Prefetch History (IndexedDB)
// ============================================================

const PREFETCH_DB_NAME = 'hypatia-zero-prefetch';
const PREFETCH_DB_VERSION = 1;
const PREFETCH_STORE = 'history';
const MAX_HISTORY_ENTRIES = 50;

/**
 * Open prefetch history database
 */
function openPrefetchDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREFETCH_DB_NAME, PREFETCH_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(PREFETCH_STORE)) {
        const store = db.createObjectStore(PREFETCH_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Save prefetch run to history
 */
async function savePrefetchHistory(entry) {
  try {
    const db = await openPrefetchDB();
    const tx = db.transaction(PREFETCH_STORE, 'readwrite');
    const store = tx.objectStore(PREFETCH_STORE);

    // Add new entry
    store.add(entry);

    // Prune old entries (keep last MAX_HISTORY_ENTRIES)
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count > MAX_HISTORY_ENTRIES) {
        const deleteCount = count - MAX_HISTORY_ENTRIES;
        const cursorRequest = store.openCursor();
        let deleted = 0;
        cursorRequest.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && deleted < deleteCount) {
            cursor.delete();
            deleted++;
            cursor.continue();
          }
        };
      }
    };

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[SW] Failed to save prefetch history:', err);
  }
}

/**
 * Get prefetch history
 */
async function getPrefetchHistory() {
  try {
    const db = await openPrefetchDB();
    const tx = db.transaction(PREFETCH_STORE, 'readonly');
    const store = tx.objectStore(PREFETCH_STORE);
    const index = store.index('timestamp');

    const entries = await new Promise((resolve, reject) => {
      const request = index.getAll(null, MAX_HISTORY_ENTRIES);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    db.close();
    // Return newest first
    return entries.reverse();
  } catch (err) {
    console.warn('[SW] Failed to get prefetch history:', err);
    return [];
  }
}

/** Timesteps per forecast day range */
const TIMESTEPS_BY_DAYS = {
  '1': 24,
  '2': 48,
  '4': 92,
  '6': 108,
  '8': 116,
};

/** Open-Meteo S3 base URL */
const OM_BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';

/** Layer to Open-Meteo parameter mapping */
const LAYER_PARAMS = {
  temp: ['temperature_2m'],
  pressure: ['pressure_msl'],
  wind: ['wind_u_component_10m', 'wind_v_component_10m'],
};

/**
 * Generate timestep URLs for prefetching
 * ECMWF: 1h to 90h, 3h to 144h, 6h after
 */
function generatePrefetchUrls(forecastDays, layers) {
  const urls = [];
  const now = new Date();
  const hoursToFetch = {
    '1': 24,
    '2': 48,
    '4': 96,
    '6': 144,
    '8': 192,
  }[forecastDays] || 48;

  // Find latest model run (00Z, 06Z, 12Z, 18Z) that's likely available (~6h delay)
  const runHour = Math.floor((now.getUTCHours() - 6) / 6) * 6;
  const runDate = new Date(now);
  runDate.setUTCHours(runHour, 0, 0, 0);
  if (runHour < 0) {
    runDate.setUTCDate(runDate.getUTCDate() - 1);
    runDate.setUTCHours(18, 0, 0, 0);
  }

  const runStr = runDate.toISOString().slice(0, 10).replace(/-/g, '/') +
                 '/' + String(runDate.getUTCHours()).padStart(2, '0') + '00Z';

  // Generate timesteps
  for (let h = 0; h <= hoursToFetch; h++) {
    // Check resolution: 1h to 90h, 3h to 144h, 6h after
    if (h > 90 && h <= 144 && h % 3 !== 0) continue;
    if (h > 144 && h % 6 !== 0) continue;

    const validTime = new Date(runDate.getTime() + h * 3600 * 1000);
    const validStr = validTime.toISOString().slice(0, 13).replace('T', 'T') + '00';
    const dateStr = validTime.toISOString().slice(0, 10);

    for (const layer of layers) {
      const params = LAYER_PARAMS[layer] || [];
      for (const param of params) {
        urls.push({
          url: `${OM_BASE_URL}/${runStr}/${param}/${dateStr}T${String(validTime.getUTCHours()).padStart(2, '0')}00.om`,
          layer,
          param,
        });
      }
    }
  }

  return urls;
}

/**
 * Prefetch a single file (just the header/metadata for now)
 * Full prefetch would require implementing the .om range request logic
 */
async function prefetchFile(urlInfo) {
  try {
    // For now, just do a HEAD request to trigger any CDN caching
    // Full implementation would parse .om file and fetch data ranges
    const response = await fetch(urlInfo.url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Handle periodic sync event
 */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'prefetch-forecast') {
    console.log('[SW] Periodic sync triggered: prefetch-forecast');
    event.waitUntil(handlePrefetch());
  }
});

/**
 * Execute prefetch based on current config
 */
async function handlePrefetch() {
  if (!prefetchConfig.enabled) {
    console.log('[SW] Prefetch disabled, skipping');
    return;
  }

  const startTime = Date.now();
  const urls = generatePrefetchUrls(prefetchConfig.forecastDays, prefetchConfig.layers);
  console.log(`[SW] Prefetching ${urls.length} files...`);

  let success = 0;
  let failed = 0;

  // Prefetch in batches to avoid overwhelming the network
  const batchSize = 5;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(prefetchFile));
    success += results.filter(r => r).length;
    failed += results.filter(r => !r).length;
  }

  const durationMs = Date.now() - startTime;
  console.log(`[SW] Prefetch complete: ${success} success, ${failed} failed in ${(durationMs / 1000).toFixed(1)}s`);

  // Save to history
  await savePrefetchHistory({
    timestamp: new Date().toISOString(),
    forecastDays: prefetchConfig.forecastDays,
    layers: [...prefetchConfig.layers],
    totalFiles: urls.length,
    success,
    failed,
    durationMs,
  });
}
