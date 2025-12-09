/**
 * Gaussian Grid (O1280) LUT generation
 *
 * ECMWF octahedral reduced Gaussian grid:
 * - 2560 latitude rings (1280 in each hemisphere)
 * - Points per ring: 4*ring + 16 (from pole)
 * - Total points: 6,599,680
 */

export interface GaussianLUTs {
  lats: Float32Array;    // 2560 latitudes in radians (N to S)
  offsets: Uint32Array;  // 2560 ring start offsets
  totalPoints: number;
}

/**
 * Generate Gaussian grid lookup tables for O1280
 */
export function generateGaussianLUTs(N: number = 1280): GaussianLUTs {
  const numRings = 2 * N; // 2560

  // Gaussian latitudes (approximate using linear spacing for MVP)
  // Real implementation would compute roots of Legendre polynomial
  const lats = new Float32Array(numRings);
  for (let i = 0; i < numRings; i++) {
    // Linear approximation: 90° to -90°
    const latDeg = 90 - (i + 0.5) * 180 / numRings;
    lats[i] = latDeg * Math.PI / 180;
  }

  // Ring offsets (cumulative point count)
  const offsets = new Uint32Array(numRings);
  let cumulative = 0;
  for (let i = 0; i < numRings; i++) {
    offsets[i] = cumulative;
    // Ring number from pole (1-indexed)
    const ringFromPole = i < N ? i + 1 : numRings - i;
    const pointsInRing = 4 * ringFromPole + 16;
    cumulative += pointsInRing;
  }

  return { lats, offsets, totalPoints: cumulative };
}

/**
 * Convert lat/lon to O1280 cell index
 */
export function latLonToCell(lat: number, lon: number, luts: GaussianLUTs): number {
  // Find ring by binary search
  let lo = 0;
  let hi = luts.lats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (luts.lats[mid]! > lat) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const ring = lo;

  // Points in this ring
  const N = luts.lats.length / 2;
  const ringFromPole = ring < N ? ring + 1 : luts.lats.length - ring;
  const nPoints = 4 * ringFromPole + 16;

  // Longitude index
  let lonNorm = lon;
  if (lonNorm < 0) lonNorm += 2 * Math.PI;
  const lonIdx = Math.floor(lonNorm / (2 * Math.PI) * nPoints) % nPoints;

  return (luts.offsets[ring] ?? 0) + lonIdx;
}
