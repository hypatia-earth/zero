/**
 * Synthetic O1280 pressure data generator for testing
 * Generates lat-based pressure gradient with optional cyclone
 */

const POINTS_PER_TIMESTEP = 6_599_680;

export interface CycloneConfig {
  lat: number;      // degrees
  lon: number;      // degrees
  depth: number;    // hPa drop at center
  radius: number;   // degrees
}

const DEFAULT_CYCLONE: CycloneConfig = {
  lat: 51,    // Germany
  lon: 10,
  depth: 40,  // hPa
  radius: 15, // ~1500km
};

/**
 * Generate synthetic O1280 pressure data
 * Base gradient: higher at equator, lower at poles
 * Optional cyclone overlay
 */
export function generateSyntheticO1280Pressure(cyclone: CycloneConfig = DEFAULT_CYCLONE): Float32Array {
  const data = new Float32Array(POINTS_PER_TIMESTEP);

  const cycloneLat = cyclone.lat * Math.PI / 180;
  const cycloneLon = (90 - cyclone.lon) * Math.PI / 180;  // O1280 grid offset
  const cycloneRadius = cyclone.radius * Math.PI / 180;

  let idx = 0;
  for (let ring = 0; ring < 2560; ring++) {
    const latDeg = 90 - (ring + 0.5) * 180 / 2560;
    const lat = latDeg * Math.PI / 180;

    const ringFromPole = ring < 1280 ? ring + 1 : 2560 - ring;
    const nPoints = 4 * ringFromPole + 16;

    for (let i = 0; i < nPoints; i++) {
      const lon = (i / nPoints) * 2 * Math.PI;

      // Base pressure: higher at equator, lower at poles
      const basePressure = 1010 + 10 * Math.cos(Math.abs(lat));

      // Great circle distance from cyclone center
      const dLon = lon - cycloneLon;
      const cosD = Math.sin(cycloneLat) * Math.sin(lat) +
                   Math.cos(cycloneLat) * Math.cos(lat) * Math.cos(dLon);
      const dist = Math.acos(Math.max(-1, Math.min(1, cosD)));

      // Gaussian pressure drop for cyclone
      const cycloneEffect = cyclone.depth * Math.exp(-(dist * dist) / (2 * cycloneRadius * cycloneRadius));

      data[idx++] = basePressure - cycloneEffect;
    }
  }

  return data;
}
