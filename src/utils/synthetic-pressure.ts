/**
 * Synthetic O1280 pressure data generator for testing coordinate mapping
 *
 * O1280 format:
 * - 2560 rings (latitude bands), ring 0 = north pole, ring 2559 = south pole
 * - Points per ring: 4 * ringFromPole + 16 (20 at poles, 5136 at equator)
 * - Total: 6,599,680 points (26.4 MB as Float32)
 * - Data is sequential: all points of ring 0, then ring 1, etc.
 */

const POINTS_PER_TIMESTEP = 6_599_680;
const BASE_PRESSURE = 101300;  // Pa (1013 hPa)
const LOW_PRESSURE = 97000;    // Pa (970 hPa) - very low, easy to see
const HIGH_PRESSURE = 105000;  // Pa (1050 hPa) - very high, easy to see

export interface PressureCenter {
  lat: number;
  lon: number;
  delta: number;
  radius: number;
}

/**
 * Calculate ring offset and points count for a given ring
 */
function getRingInfo(ring: number): { offset: number; nPoints: number } {
  let offset = 0;
  for (let r = 0; r < ring; r++) {
    const rfp = r < 1280 ? r + 1 : 2560 - r;
    offset += 4 * rfp + 16;
  }
  const rfp = ring < 1280 ? ring + 1 : 2560 - ring;
  const nPoints = 4 * rfp + 16;
  return { offset, nPoints };
}

/**
 * Generate test O1280 pressure data with HIGH and LOW on opposite sides.
 *
 * O1280 coordinate system (discovered via testing):
 * - lonIdx=0 corresponds to 90°E
 * - Longitude increases WESTWARD (decreasing eastward)
 * - Formula: lonIdx = (90° - targetLon) / 360° * nPoints
 */
export function generateSyntheticO1280Pressure(
  gaussianLats: Float32Array,
  _centers?: PressureCenter[]  // unused, kept for API compatibility
): Float32Array {
  const data = new Float32Array(POINTS_PER_TIMESTEP);
  data.fill(BASE_PRESSURE);

  // HIGH at 45°N, 0°E (Europe)
  applyPressureCenter(data, gaussianLats, 45, 0, HIGH_PRESSURE, 20);

  // LOW at 45°S, 180°E (opposite side - Pacific)
  applyPressureCenter(data, gaussianLats, -45, 180, LOW_PRESSURE, 20);


  return data;
}

/**
 * Apply a pressure center with Gaussian falloff for realistic concentric contours.
 * @param radiusDeg - radius in degrees for the pressure anomaly
 */
function applyPressureCenter(
  data: Float32Array,
  gaussianLats: Float32Array,
  targetLat: number,
  targetLon: number,
  centerPressure: number,
  radiusDeg: number
): void {
  const targetLatRad = targetLat * Math.PI / 180;
  const targetLonRad = targetLon * Math.PI / 180;
  const radiusRad = radiusDeg * Math.PI / 180;

  let idx = 0;
  for (let ring = 0; ring < 2560; ring++) {
    const lat = gaussianLats[ring]!;
    const rfp = ring < 1280 ? ring + 1 : 2560 - ring;
    const nPoints = 4 * rfp + 16;

    for (let i = 0; i < nPoints; i++) {
      // O1280 longitude: starts at 90°E, increases westward
      const lonDeg = 90 - (i / nPoints) * 360;
      const lon = lonDeg * Math.PI / 180;

      // Great circle distance
      const dLon = lon - targetLonRad;
      const cosD = Math.sin(targetLatRad) * Math.sin(lat) +
                   Math.cos(targetLatRad) * Math.cos(lat) * Math.cos(dLon);
      const dist = Math.acos(Math.max(-1, Math.min(1, cosD)));

      // Gaussian falloff
      if (dist < radiusRad * 3) {  // Only compute within 3x radius
        const delta = (centerPressure - BASE_PRESSURE) * Math.exp(-(dist * dist) / (2 * radiusRad * radiusRad));
        data[idx] = BASE_PRESSURE + delta;
      }

      idx++;
    }
  }
}

/**
 * Legacy function signature for compatibility
 */
export function generateSyntheticO1280PressureSimple(): Float32Array {
  console.warn('[SyntheticPressure] Called without gaussianLats - using approximate positions');
  const data = new Float32Array(POINTS_PER_TIMESTEP);
  data.fill(BASE_PRESSURE);

  // Just place one marker at equator lonIdx=0
  const eq = getRingInfo(1280);
  for (let di = -50; di <= 50; di++) {
    const lonIdx = (di + eq.nPoints) % eq.nPoints;
    data[eq.offset + lonIdx] = LOW_PRESSURE;
  }

  return data;
}
