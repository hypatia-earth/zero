/**
 * Options Sanitization
 *
 * Runs ONCE at bootstrap to merge and validate options from URL + IndexedDB.
 * Applies business logic and runtime context to produce clean ZeroOptions.
 */

import type { ZeroOptions } from '../schemas/options.schema.ts';
import { defaultOptions } from '../schemas/options.schema.ts';

/**
 * Runtime context needed for sanitization
 */
export interface SanitizeContext {
  screenWidth: number;
  screenHeight: number;
  now: Date;
}

/**
 * Deep merge two objects, with source values taking precedence
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;

  for (const key in source) {
    const sourceValue = source[key];
    if (sourceValue === undefined) continue;

    const targetValue = result[key];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Sanitize raw merged options (from URL + IndexedDB) at bootstrap
 *
 * Business logic:
 * - viewState.altitude: calculated from screen size if not provided
 * - viewState.time: defaults to context.now if not provided
 * - viewState.lat/lon: clamped to valid range
 */
export function sanitize(raw: Partial<ZeroOptions>, context: SanitizeContext): ZeroOptions {
  // Start with defaults, merge in raw values
  const merged = deepMerge(defaultOptions, raw);

  // viewState.time: default to now
  const rawViewState = raw.viewState as Record<string, unknown> | undefined;
  if (!rawViewState?.time) {
    merged.viewState.time = context.now;
  }

  // viewState.altitude: calculate from screen size if not provided (km from surface)
  if (!rawViewState?.altitude) {
    const baseSize = Math.max(context.screenWidth, context.screenHeight);
    merged.viewState.altitude = Math.max(300, Math.min(36_000, baseSize * 7));
  }

  // viewState.lat: clamp to valid range
  merged.viewState.lat = Math.max(-90, Math.min(90, merged.viewState.lat));

  // viewState.lon: normalize to -180..180
  merged.viewState.lon = ((merged.viewState.lon + 180) % 360) - 180;

  return merged;
}
