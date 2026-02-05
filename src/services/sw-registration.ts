/**
 * Service Worker Registration
 *
 * Registers the SW for Range request caching and exposes console utilities.
 * Optionally registers Periodic Background Sync for prefetching.
 */

import { SW_CACHED_WEATHER_LAYERS } from '../config/types';
import { sendSWMessage } from '../utils/sw-message';

/** Prefetch configuration passed to SW */
export interface PrefetchConfig {
  enabled: boolean;
  forecastDays: string;
  layers: string[];  // ['temp', 'pressure', 'wind']
}

// Extend ServiceWorkerRegistration for Periodic Sync (not in all TS libs)
interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

interface ServiceWorkerRegistrationWithPeriodicSync extends ServiceWorkerRegistration {
  periodicSync?: PeriodicSyncManager;
}

/** Layer stats from SW */
interface LayerStats {
  entries: number;
  sizeMB: string;
}

/** Cache stats from SW */
interface CacheStats {
  layers: Record<string, LayerStats>;
  totalEntries: number;
  totalSizeMB: string;
}

/** Detailed layer stats from SW */
interface LayerDetail {
  layer: string;
  entries: number;
  totalSizeMB: string;
  items: Array<{
    url: string;
    sizeMB: string;
    cachedAt: string | null;
  }>;
}


/**
 * Register the Service Worker
 */
export async function registerServiceWorker(): Promise<void> {
  // Skip SW registration if debug=nosw is in URL (for e2e testing)
  const debugFlags = new URLSearchParams(location.search).get('debug')?.split(',') ?? [];
  if (debugFlags.includes('nosw')) {
    console.log('[SW] Skipped (debug=nosw)');
    return;
  }

  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    await navigator.serviceWorker.ready;

    // Wait for SW to claim this client (skipWaiting + clients.claim), with timeout
    if (!navigator.serviceWorker.controller) {
      let timedOut = false;
      await Promise.race([
        new Promise<void>(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        }),
        new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, 2000)),
      ]);
      if (timedOut) {
        // Try explicit claim via message
        try {
          await sendSWMessage({ type: 'CLAIM' });
          await new Promise(r => setTimeout(r, 100));
          if (!navigator.serviceWorker.controller) {
            console.warn('[SW] Still no controller after CLAIM request');
          }
        } catch {
          console.warn('[SW] Timeout waiting for controller, continuing without SW');
        }
      }
    }

    // Ping SW to confirm it's fully activated, then log cache stats
    await sendSWMessage({ type: 'PING' });
    await logCachedTimesteps();

    // Setup cache utils for debugging (localhost only)
    if (location.hostname === 'localhost') {
      setupCacheUtils();
    }
  } catch (error) {
    console.error('[SW] Registration failed:', error);
  }
}

/**
 * Log cached timesteps per weather layer
 */
async function logCachedTimesteps(): Promise<void> {
  try {
    const stats = await sendSWMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
    const codes: Record<string, string> = { temp: 'T', rain: 'R', clouds: 'C', humidity: 'H', pressure: 'P', wind: 'W' };
    const parts = SW_CACHED_WEATHER_LAYERS
      .map(layer => {
        const n = stats.layers[layer]?.entries ?? 0;
        return n > 0 ? `${codes[layer]}:${n}` : null;
      })
      .filter(Boolean);
    const cacheInfo = parts.length > 0 ? ` cache: ${parts.join(' ')}` : '';
    console.log(`[SW] Ready${cacheInfo}`);
  } catch {
    console.log('[SW] Ready');
  }
}

/**
 * Clear the entire cache (all layers)
 */
export async function clearCache(): Promise<boolean> {
  const result = await sendSWMessage<{ success: boolean }>({ type: 'CLEAR_CACHE' });
  console.log(result.success ? '[SW] All caches cleared' : '[SW] No caches found');
  return result.success;
}

/**
 * Clear cache for a specific layer
 */
async function clearLayerCache(layer: string): Promise<boolean> {
  const result = await sendSWMessage<{ success: boolean; layer: string }>({ type: 'CLEAR_LAYER_CACHE', layer });
  console.log(result.success ? `[SW] Cache cleared for layer: ${layer}` : `[SW] No cache found for layer: ${layer}`);
  return result.success;
}

/**
 * Get cache statistics (per layer and total)
 */
async function getCacheStats(): Promise<CacheStats> {
  const result = await sendSWMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
  console.log(`[SW] Cache total: ${result.totalEntries} entries, ${result.totalSizeMB} MB`);
  console.table(result.layers);
  return result;
}

/**
 * Get detailed stats for a specific layer
 */
async function getLayerStats(layer: string): Promise<LayerDetail> {
  const result = await sendSWMessage<LayerDetail>({ type: 'GET_LAYER_STATS', layer });
  console.log(`[SW] Layer '${layer}': ${result.entries} entries, ${result.totalSizeMB} MB`);
  if (result.items.length > 0) {
    console.table(result.items.slice(0, 20)); // Show first 20
    if (result.items.length > 20) {
      console.log(`... and ${result.items.length - 20} more entries`);
    }
  }
  return result;
}

/**
 * Clear entries older than N days
 */
async function clearOlderThan(days: number): Promise<number> {
  const result = await sendSWMessage<{ deleted: number }>({ type: 'CLEAR_OLDER_THAN', days });
  console.log(`[SW] Deleted ${result.deleted} entries older than ${days} days`);
  return result.deleted;
}

/**
 * Count cache entries before a timestep
 */
export async function countBeforeTimestep(cutoffIso: string): Promise<number> {
  const result = await sendSWMessage<{ count: number }>({ type: 'COUNT_BEFORE_TIMESTEP', cutoffIso });
  return result.count;
}

/**
 * Clear cache entries before a timestep
 */
export async function clearBeforeTimestep(cutoffIso: string): Promise<number> {
  const result = await sendSWMessage<{ deleted: number }>({ type: 'CLEAR_BEFORE_TIMESTEP', cutoffIso });
  return result.deleted;
}

/**
 * Unregister SW, clear cache, and hard refresh
 */
async function unregister(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const reg of registrations) {
    await reg.unregister();
  }
  // Clear all om- caches
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('om-')).map(k => caches.delete(k)));
  console.log('[SW] Unregistered and caches cleared, reloading...');
  location.reload();
}

/**
 * Nuclear option: delete IndexedDB, unregister SW, clear caches, reload
 */
export async function nuke(): Promise<void> {
  // Delete IndexedDB
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.filter(db => db.name).map(db => {
    console.log(`[Nuke] Deleting IndexedDB: ${db.name}`);
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(db.name!);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }));
  // Unregister SW and clear caches
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const reg of registrations) {
    await reg.unregister();
  }
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  console.log('[Nuke] All data cleared, reloading...');
  location.reload();
}

/**
 * Trigger manual prefetch (for testing)
 */
export async function triggerPrefetch(): Promise<void> {
  console.log('[SW] Triggering manual prefetch...');
  await sendSWMessage({ type: 'TRIGGER_PREFETCH' });
}

/**
 * Setup console utilities (call after SW is ready)
 */
export function setupCacheUtils(): void {
  const utils = {
    clearCache,
    clearLayerCache,
    getCacheStats,
    getLayerStats,
    clearOlderThan,
    unregister,
    prefetch: triggerPrefetch,
    prefetchHistory: getPrefetchHistory,
    clearPrefetchHistory,
    help: () => {
      console.log(`
__omCache utilities:
  getCacheStats()         - Show all layer caches with entry count and size
  getLayerStats('temp')   - Show detailed entries for a layer (temp, wind, rain, pressure, meta)
  clearCache()            - Clear all layer caches
  clearLayerCache('temp') - Clear a specific layer cache
  clearOlderThan(7)       - Clear entries older than N days
  unregister()            - Unregister SW and clear caches
  prefetch()              - Trigger manual prefetch (test)
  prefetchHistory()       - Show prefetch history
  clearPrefetchHistory()  - Clear prefetch history
      `);
    }
  };

  window.__omCache = utils;
}

// ============================================================
// Periodic Background Sync
// ============================================================

const PERIODIC_SYNC_TAG = 'prefetch-forecast';
const PERIODIC_SYNC_MIN_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Check if Periodic Background Sync is supported
 */
export function isPeriodicSyncSupported(): boolean {
  return 'serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype;
}

/**
 * Register periodic sync for background prefetching
 * Only works on Chrome/Edge with sufficient site engagement
 */
export async function registerPeriodicSync(): Promise<boolean> {
  if (!isPeriodicSyncSupported()) {
    console.log('[SW] Periodic Sync not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready as ServiceWorkerRegistrationWithPeriodicSync;
    if (!registration.periodicSync) {
      console.log('[SW] Periodic Sync manager not available');
      return false;
    }

    // Check if already registered
    const tags = await registration.periodicSync.getTags();
    if (tags.includes(PERIODIC_SYNC_TAG)) {
      console.log('[SW] Periodic Sync already registered');
      return true;
    }

    await registration.periodicSync.register(PERIODIC_SYNC_TAG, {
      minInterval: PERIODIC_SYNC_MIN_INTERVAL,
    });
    console.log('[SW] Periodic Sync registered');
    return true;
  } catch (error) {
    // Permission denied or not enough engagement
    console.log('[SW] Periodic Sync registration failed:', error);
    return false;
  }
}

/**
 * Unregister periodic sync
 */
export async function unregisterPeriodicSync(): Promise<void> {
  if (!isPeriodicSyncSupported()) return;

  try {
    const registration = await navigator.serviceWorker.ready as ServiceWorkerRegistrationWithPeriodicSync;
    if (registration.periodicSync) {
      await registration.periodicSync.unregister(PERIODIC_SYNC_TAG);
      console.log('[SW] Periodic Sync unregistered');
    }
  } catch (error) {
    console.warn('[SW] Periodic Sync unregister failed:', error);
  }
}

/**
 * Update prefetch configuration in SW
 * Called when user changes prefetch settings
 */
export async function updatePrefetchConfig(config: PrefetchConfig): Promise<void> {
  try {
    // Send config to SW
    await sendSWMessage({ type: 'SET_PREFETCH_CONFIG', config });

    // Register/unregister periodic sync based on enabled state
    if (config.enabled) {
      const success = await registerPeriodicSync();
      if (!success) {
        console.log('[SW] Prefetch enabled but Periodic Sync not available');
      }
    } else {
      await unregisterPeriodicSync();
    }
  } catch (error) {
    console.error('[SW] Failed to update prefetch config:', error);
  }
}

/**
 * Get current periodic sync status
 */
export async function getPeriodicSyncStatus(): Promise<{ supported: boolean; registered: boolean }> {
  if (!isPeriodicSyncSupported()) {
    return { supported: false, registered: false };
  }

  try {
    const registration = await navigator.serviceWorker.ready as ServiceWorkerRegistrationWithPeriodicSync;
    if (!registration.periodicSync) {
      return { supported: false, registered: false };
    }

    const tags = await registration.periodicSync.getTags();
    return { supported: true, registered: tags.includes(PERIODIC_SYNC_TAG) };
  } catch {
    return { supported: true, registered: false };
  }
}

// ============================================================
// Prefetch History
// ============================================================

/** Prefetch history entry */
export interface PrefetchHistoryEntry {
  id: number;
  timestamp: string;
  forecastDays: string;
  layers: string[];
  totalFiles: number;
  success: number;
  failed: number;
  durationMs: number;
}

/**
 * Get prefetch history from SW
 */
export async function getPrefetchHistory(): Promise<PrefetchHistoryEntry[]> {
  try {
    return await sendSWMessage<PrefetchHistoryEntry[]>({ type: 'GET_PREFETCH_HISTORY' });
  } catch {
    return [];
  }
}

/**
 * Clear prefetch history
 */
export async function clearPrefetchHistory(): Promise<boolean> {
  try {
    const result = await sendSWMessage<{ success: boolean }>({ type: 'CLEAR_PREFETCH_HISTORY' });
    return result.success;
  } catch {
    return false;
  }
}
