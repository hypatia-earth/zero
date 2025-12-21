/**
 * Options Sanitization
 *
 * Runs ONCE at bootstrap to merge and validate options from URL + IndexedDB.
 * Applies business logic and runtime context to produce clean ZeroOptions.
 */

import type { ZeroOptions } from '../schemas/options.schema.ts';
import { defaultOptions } from '../schemas/options.schema.ts';
import { deepMerge } from './object';

/**
 * Runtime context needed for sanitization
 */
export interface SanitizeContext {
  screenWidth: number;
  screenHeight: number;
  now: Date;
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
