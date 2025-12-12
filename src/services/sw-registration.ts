/**
 * Service Worker Registration
 *
 * Registers the SW for Range request caching and exposes console utilities.
 */

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

/** Weather layer IDs (must match defaults.layers where category='weather') */
const WEATHER_LAYERS = ['temp', 'rain'];

/**
 * Register the Service Worker
 */
export async function registerServiceWorker(): Promise<void> {
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Log available cached timesteps
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
    const stats = await sendMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
    const parts = WEATHER_LAYERS
      .map(layer => {
        const layerStats = stats.layers[layer];
        return layerStats ? `${layer}: ${layerStats.entries}` : `${layer}: 0`;
      });
    console.log(`[SW] Registered! Cached: ${parts.join(', ')}`);
  } catch {
    console.log('[SW] Registered (no cache stats yet)');
  }
}

/**
 * Send message to SW and wait for response
 */
function sendMessage<T>(message: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker.controller) {
      reject(new Error('No active Service Worker'));
      return;
    }

    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data as T);
    navigator.serviceWorker.controller.postMessage(message, [channel.port2]);
  });
}

/**
 * Clear the entire cache (all layers)
 */
async function clearCache(): Promise<boolean> {
  const result = await sendMessage<{ success: boolean }>({ type: 'CLEAR_CACHE' });
  console.log(result.success ? '[SW] All caches cleared' : '[SW] No caches found');
  return result.success;
}

/**
 * Clear cache for a specific layer
 */
async function clearLayerCache(layer: string): Promise<boolean> {
  const result = await sendMessage<{ success: boolean; layer: string }>({ type: 'CLEAR_LAYER_CACHE', layer });
  console.log(result.success ? `[SW] Cache cleared for layer: ${layer}` : `[SW] No cache found for layer: ${layer}`);
  return result.success;
}

/**
 * Get cache statistics (per layer and total)
 */
async function getCacheStats(): Promise<CacheStats> {
  const result = await sendMessage<CacheStats>({ type: 'GET_CACHE_STATS' });
  console.log(`[SW] Cache total: ${result.totalEntries} entries, ${result.totalSizeMB} MB`);
  console.table(result.layers);
  return result;
}

/**
 * Get detailed stats for a specific layer
 */
async function getLayerStats(layer: string): Promise<LayerDetail> {
  const result = await sendMessage<LayerDetail>({ type: 'GET_LAYER_STATS', layer });
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
  const result = await sendMessage<{ deleted: number }>({ type: 'CLEAR_OLDER_THAN', days });
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

  (window as unknown as { __omCache: typeof utils }).__omCache = utils;
}
