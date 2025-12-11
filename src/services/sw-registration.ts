/**
 * Service Worker Registration
 *
 * Registers the SW for Range request caching and exposes console utilities.
 */


/**
 * Register the Service Worker
 */
export async function registerServiceWorker(): Promise<void> {
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Setup cache utils for debugging (localhost only)
    if (location.hostname === 'localhost') {
      setupCacheUtils();
    }
  } catch (error) {
    console.error('[SW] Registration failed:', error);
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
 * Clear the entire cache
 */
async function clearCache(): Promise<boolean> {
  const result = await sendMessage<{ success: boolean }>({ type: 'CLEAR_CACHE' });
  console.log(result.success ? '[SW] Cache cleared' : '[SW] No cache found');
  return result.success;
}

/**
 * Get cache statistics
 */
async function getCacheStats(): Promise<{ entries: number; totalSizeMB: string }> {
  const result = await sendMessage<{ entries: number; totalSizeMB: string }>({ type: 'GET_CACHE_STATS' });
  console.log(`[SW] Cache: ${result.entries} entries, ${result.totalSizeMB} MB`);
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
  await caches.delete('om-ranges-v1');
  console.log('[SW] Unregistered and cache cleared, reloading...');
  location.reload();
}

/**
 * Setup console utilities (call after SW is ready)
 */
export function setupCacheUtils(): void {
  const utils = {
    clearCache,
    getCacheStats,
    clearOlderThan,
    unregister,
  };

  (window as unknown as { __omCache: typeof utils }).__omCache = utils;
  console.log('[SW] Registered for Range caching, utils available');
}
