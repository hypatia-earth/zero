/**
 * Grid model specification — describes the data grid aurora receives data on.
 *
 * Two grid families today: regular lat/lon and reduced gaussian.
 */

export interface ModelSpec {
  id: string;
  grid: 'gaussian' | 'lat-lon-regular';
  dims: {
    latCount: number;
    lonCount: number;
  };
  /** Required for gaussian grids: latitude of each ring (length = latCount). */
  gaussianLats?: Float32Array;
  /** Required for gaussian grids: prefix-sum of points per ring (length = latCount + 1). */
  ringOffsets?: Uint32Array;
}
