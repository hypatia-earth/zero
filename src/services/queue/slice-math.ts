/**
 * Slice count calculation for .om file streaming
 *
 * Used by om-adapter (fetcher) and cache (validator) to agree
 * on how many HTTP Range slices a param download produces.
 */

/** Bytes per slice target — balances parallelism vs HTTP overhead */
const BYTES_PER_SLICE = 500_000;

/** Default max slices (worker default) */
const DEFAULT_MAX_SLICES = 10;

/**
 * Calculate the expected number of data slices for a param download.
 * Must match the logic in om-adapter's streamOmVariable.
 */
export function calcSliceCount(sizeEstimate: number, maxSlices = DEFAULT_MAX_SLICES): number {
  const optimal = Math.max(1, Math.ceil(sizeEstimate / BYTES_PER_SLICE));
  return Math.min(maxSlices, optimal);
}
