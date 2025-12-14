/**
 * Debounce utility - limits how often a function can execute
 */

/**
 * Creates a debounced function that only executes once per interval
 * @param fn Function to debounce
 * @param ms Minimum milliseconds between executions
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number
): T {
  let lastCall = 0;
  return ((...args: Parameters<T>) => {
    const now = performance.now();
    if (now - lastCall < ms) return;
    lastCall = now;
    fn(...args);
  }) as T;
}
