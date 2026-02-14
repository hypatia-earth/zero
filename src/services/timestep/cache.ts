/**
 * Cache State - Service Worker cache queries and state management
 *
 * Queries the Service Worker for cached timestep data and manages
 * the cache state in the TimestepService signal.
 */

import type { Signal } from '@preact/signals-core';
import type { TTimestep, Timestep } from '../../config/types';
import { sendSWMessage } from '../../utils/sw-message';
import type { TimestepState } from './timestep-service';

const DEBUG = false;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ParamDetail {
  items: Array<{ url: string; sizeMB: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SW Cache Query
// ─────────────────────────────────────────────────────────────────────────────

export async function querySWCache(
  param: string,
  timestepsData: Timestep[]
): Promise<{ cache: Set<TTimestep>; sizes: Map<TTimestep, number> }> {
  const cache = new Set<TTimestep>();
  const sizes = new Map<TTimestep, number>();
  const rangeCount = new Map<TTimestep, number>();

  try {
    const detail = await sendSWMessage<ParamDetail>({
      type: 'GET_PARAM_STATS',
      param,
    });

    const now = Date.now();

    // Build maps for matching:
    // 1. Full path → timestep (for future data, must match exact model run)
    // 2. Past timesteps set (for retention data, any model run is valid)
    const pathToTimestep = new Map<string, TTimestep>();
    const pastTimesteps = new Set<TTimestep>();

    for (const ts of timestepsData) {
      const urlPath = new URL(ts.url).pathname;
      pathToTimestep.set(urlPath, ts.timestep);

      // Check if timestep is in the past (retention/reanalysis data)
      // Format: "2026-01-04T0000" → Date
      const tsDate = new Date(ts.timestep.replace(/T(\d{2})(\d{2})$/, 'T$1:$2:00Z'));
      if (tsDate.getTime() < now) {
        pastTimesteps.add(ts.timestep);
      }
    }

    for (const item of detail.items) {
      const cachedPath = new URL(item.url).pathname;

      // Try exact path match first (works for current model run)
      let ts = pathToTimestep.get(cachedPath);

      // For past timesteps, also match by timestep only (any model run is valid)
      if (!ts) {
        const match = cachedPath.match(/(\d{4}-\d{2}-\d{2}T\d{4})\.om$/);
        if (match) {
          const cachedTimestep = match[1] as TTimestep;
          if (pastTimesteps.has(cachedTimestep)) {
            ts = cachedTimestep;
          }
        }
      }

      if (ts) {
        rangeCount.set(ts, (rangeCount.get(ts) ?? 0) + 1);
        const sizeBytes = parseFloat(item.sizeMB) * 1024 * 1024;
        if (!isNaN(sizeBytes)) {
          sizes.set(ts, (sizes.get(ts) ?? 0) + sizeBytes);
        }
      }
    }

    // Only mark as cached if >= 10 ranges (data slices) completed
    // Partial downloads from aborted fetches have fewer ranges
    for (const [ts, count] of rangeCount) {
      if (count >= 10) {
        cache.add(ts);
      }
    }
  } catch (err) {
    DEBUG && console.warn(`[Cache] SW cache query failed for ${param}:`, err);
  }

  return { cache, sizes };
}

// ─────────────────────────────────────────────────────────────────────────────
// State Updates
// ─────────────────────────────────────────────────────────────────────────────

/** Mark timestep as cached (called after successful fetch) */
export function setCached(
  state: Signal<TimestepState>,
  param: string,
  timestep: TTimestep,
  sizeBytes: number
): void {
  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.cache.add(timestep);
  // Accumulate size (multi-slab layers like wind have U+V)
  const existing = paramState.sizes.get(timestep) ?? 0;
  paramState.sizes.set(timestep, existing + sizeBytes);
  state.value = { ...current };
}

/** Refresh cache state for a param from SW */
export async function refreshCacheState(
  state: Signal<TimestepState>,
  param: string,
  timestepsData: Timestep[]
): Promise<void> {
  const { cache, sizes } = await querySWCache(param, timestepsData);

  // Don't wipe cache state if SW query failed or returned empty
  if (cache.size === 0) return;

  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.cache = cache;
  // Merge new sizes (don't overwrite existing)
  for (const [ts, size] of sizes) {
    if (!paramState.sizes.has(ts)) {
      paramState.sizes.set(ts, size);
    }
  }
  state.value = { ...current };
}
