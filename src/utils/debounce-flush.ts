/**
 * Debounce with flush capability
 * Use when you need to force pending calls (e.g., before page unload)
 */

export interface DebouncedFlush<T extends (...args: unknown[]) => void> {
  /** Call the debounced function */
  (...args: Parameters<T>): void;
  /** Force execute pending call immediately (no-op if nothing pending) */
  flush(): void;
  /** Cancel pending call without executing */
  cancel(): void;
  /** True if there's a pending call */
  pending: boolean;
}

export function debounceFlush<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): DebouncedFlush<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const flush = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }
  };

  const cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
      lastArgs = null;
    }
  };

  const debounced = ((...args: Parameters<T>) => {
    lastArgs = args;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      fn(...args);
      lastArgs = null;
    }, ms);
  }) as DebouncedFlush<T>;

  debounced.flush = flush;
  debounced.cancel = cancel;
  Object.defineProperty(debounced, 'pending', {
    get: () => timeout !== null
  });

  return debounced;
}
