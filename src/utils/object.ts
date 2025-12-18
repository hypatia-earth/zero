/**
 * Object utilities - deep merge and path access
 */

/**
 * Deep merge source into target, returning new object
 * Handles Date objects specially (no recursion)
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];
    // Handle Date specially - don't recurse into it
    if (sourceValue instanceof Date) {
      result[key] = sourceValue as T[keyof T];
    } else if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }
  return result;
}

/**
 * Get value at dot-separated path (e.g., 'foo.bar.baz')
 */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
