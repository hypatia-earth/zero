/**
 * Service Worker Registration
 *
 * Registers the SW for Range request caching and exposes console utilities.
 * Optionally registers Periodic Background Sync for prefetching.
 */

import { sendSWMessage } from '../utils/sw-message';

/** Prefetch configuration passed to SW */
export interface PrefetchConfig {
  enabled: boolean;
  forecastDays: string;
  layers: string[];  // ['temp', 'pressure', 'wind'] - user-facing layer names
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

/** Param stats from SW */
interface ParamStats {
  entries: number;
  sizeMB: string;
}

/** Cache stats from SW */
interface CacheStats {
  params: Record<string, ParamStats>;
  totalEntries: number;
  totalSizeMB: string;
}

/** Detailed param stats from SW */
export interface ParamDetail {
  param: string;
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
 * Log cached timesteps per param
 */
async function logCachedTimesteps(): Promise<void> {
  try {
    const stats = await sendSWMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
    const parts = Object.entries(stats.params)
      .filter(([, s]) => s.entries > 0)
      .map(([param, s]) => `${param.slice(0, 4)}:${s.entries}`);
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
 * Clear cache for a specific param
 */
async function clearParamCache(param: string): Promise<boolean> {
  const result = await sendSWMessage<{ success: boolean; param: string }>({ type: 'CLEAR_PARAM_CACHE', param });
  console.log(result.success ? `[SW] Cache cleared for param: ${param}` : `[SW] No cache found for param: ${param}`);
  return result.success;
}

/**
 * Get cache statistics (per param and total)
 */
async function getCacheStats(): Promise<CacheStats> {
  const result = await sendSWMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
  console.log(`[SW] Cache total: ${result.totalEntries} entries, ${result.totalSizeMB} MB`);
  console.table(result.params);
  return result;
}

/**
 * Get detailed stats for a specific param
 */
async function getParamStats(param: string): Promise<ParamDetail> {
  const result = await sendSWMessage<ParamDetail>({ type: 'GET_PARAM_STATS', param });
  console.log(`[SW] Param '${param}': ${result.entries} entries, ${result.totalSizeMB} MB`);
  if (result.items.length > 0) {
    console.table(result.items.slice(0, 20)); // Show first 20
    if (result.items.length > 20) {
      console.log(`... and ${result.items.length - 20} more entries`);
    }
  }
  return result;
}

/** Export for timestep-service */
export async function querySWCacheForParam(param: string): Promise<ParamDetail> {
  return sendSWMessage<ParamDetail>({ type: 'GET_PARAM_STATS', param });
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
    clearParamCache,
    getCacheStats,
    getParamStats,
    clearOlderThan,
    unregister,
    prefetch: triggerPrefetch,
    prefetchHistory: getPrefetchHistory,
    clearPrefetchHistory,
    help: () => {
      console.log(`
__omCache utilities:
  getCacheStats()                    - Show all param caches with entry count and size
  getParamStats('temperature_2m')    - Show detailed entries for a param
  clearCache()                       - Clear all param caches
  clearParamCache('temperature_2m')  - Clear a specific param cache
  clearOlderThan(7)                  - Clear entries older than N days
  unregister()                       - Unregister SW and clear caches
  prefetch()                         - Trigger manual prefetch (test)
  prefetchHistory()                  - Show prefetch history
  clearPrefetchHistory()             - Clear prefetch history
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
