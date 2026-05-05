/**
 * Picking — `pickAt(x, y)` returns the geographic point and the layer that
 * sourced the sampled value, or all-null when the cursor misses the globe.
 */

export interface PickResult {
  latLon: [number, number] | null;
  layerId: string | null;
  sampledValue: number | null;
}
