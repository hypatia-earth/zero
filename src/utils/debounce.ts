/**
 * Debounce/throttle utilities
 */

/**
 * Throttle: executes immediately, rate-limited, last call always comes through
 */
export function throttle<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number
): T {
  let lastCall = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    const now = performance.now();
    if (timeout) clearTimeout(timeout);
    if (now - lastCall >= ms) {
      lastCall = now;
      fn(...args);
    } else {
      // Schedule trailing call
      timeout = setTimeout(() => {
        lastCall = performance.now();
        fn(...args);
      }, ms - (now - lastCall));
    }
  }) as T;
}

/**
 * Debounce: waits until calls stop, then executes (trailing edge)
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number
): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  }) as T;
}
