/**
 * Queue Sorter - Timestep sorting strategies
 *
 * Sorts items by proximity to current time with strategy options:
 * - 'alternate': closest to current time first (past or future)
 * - 'future-first': all future before all past, then by proximity
 */

import type { TTimestep } from '../../config/types';

/** Parse timestep string to Date */
function toDate(ts: TTimestep): Date {
  // Format: "2025-12-19T0400" -> "2025-12-19T04:00:00Z"
  const formatted = ts.slice(0, 11) + ts.slice(11, 13) + ':00:00Z';
  return new Date(formatted);
}

/**
 * Sort items by timestep proximity to current time
 *
 * @param items - Array to sort in place
 * @param getTimestep - Accessor function to get timestep from item
 * @param currentTime - Reference time for distance calculation
 * @param strategy - 'alternate' (closest first) or 'future-first'
 */
export function sortByTimestep<T>(
  items: T[],
  getTimestep: (item: T) => TTimestep,
  currentTime: Date,
  strategy: 'alternate' | 'future-first'
): void {
  if (items.length <= 1) return;

  const currentMs = currentTime.getTime();

  items.sort((a, b) => {
    const tsA = toDate(getTimestep(a));
    const tsB = toDate(getTimestep(b));
    const msA = tsA.getTime();
    const msB = tsB.getTime();
    const distA = Math.abs(msA - currentMs);
    const distB = Math.abs(msB - currentMs);

    if (strategy === 'future-first') {
      const isFutureA = msA >= currentMs;
      const isFutureB = msB >= currentMs;
      // Primary: all future before all past
      if (isFutureA !== isFutureB) return isFutureA ? -1 : 1;
    }
    // Secondary (or primary for 'alternate'): closest first
    return distA - distB;
  });
}
