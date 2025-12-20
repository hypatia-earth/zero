/**
 * Service Worker Registration
 *
 * Registers the SW for Range request caching and exposes console utilities.
 */

import { SW_CACHED_WEATHER_LAYERS } from '../config/types';
import { sendSWMessage } from '../utils/sw-message';

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
  try {
    await navigator.serviceWorker.register('/sw.js');
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
        console.warn('[SW] Timeout waiting for controller, continuing without SW');
      }
    }

    // Log available cached slices
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
    const codes: Record<string, string> = { temp: 'temp', rain: 'rain', clouds: 'clou', humidity: 'humi', pressure: 'pres', wind: 'wind' };
    const parts = SW_CACHED_WEATHER_LAYERS
      .map(layer => {
        const layerStats = stats.layers[layer];
        const code = codes[layer] ?? layer.slice(0, 4);
        return `${code}: ${layerStats?.entries ?? 0}`;
      });
    console.log(`[SW] Reg OK, C: ${parts.join(', ')}`);
  } catch {
    console.log('[SW] Registered (no cache stats yet)');
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
    help: () => {
      console.log(`
__omCache utilities:
  getCacheStats()         - Show all layer caches with entry count and size
  getLayerStats('temp')   - Show detailed entries for a layer (temp, wind, rain, pressure, meta)
  clearCache()            - Clear all layer caches
  clearLayerCache('temp') - Clear a specific layer cache
  clearOlderThan(7)       - Clear entries older than N days
  unregister()            - Unregister SW and clear caches
      `);
    }
  };

  window.__omCache = utils;
}
