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

/** Resolve type at a dot-separated path (e.g., PathValue<{a:{b:number}}, 'a.b'> = number) */
type PathValue<T, P extends string> =
  P extends `${infer K}.${infer Rest}`
    ? K extends keyof T ? PathValue<T[K], Rest> : unknown
    : P extends keyof T ? T[P] : unknown;

/**
 * Get value at dot-separated path (e.g., 'foo.bar.baz')
 */
export function getByPath<T, P extends string>(obj: T, path: P): PathValue<T, P> {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj) as PathValue<T, P>;
}

/**
 * Set value at dot-separated path (mutates object)
 */
export function setByPath<T, P extends string>(obj: T, path: P, value: PathValue<T, P>): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
  (target as Record<string, unknown>)[last] = value;
}
