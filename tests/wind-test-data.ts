/**
 * Synthetic O1280 hurricane U/V wind data generator for testing
 * Generates realistic hurricane wind field with cyclonic rotation
 */

const POINTS_PER_TIMESTEP = 6_599_680;
const EARTH_RADIUS_KM = 6371;

export interface HurricaneConfig {
  lat: number;           // degrees
  lon: number;           // degrees
  eyeRadius: number;     // km
  maxWindRadius: number; // km
  maxWindSpeed: number;  // m/s
}

export interface WindData {
  u: Float32Array;  // eastward wind (m/s)
  v: Float32Array;  // northward wind (m/s)
}

export interface HurricaneTimesteps {
  t0: WindData;
  t1: WindData;
}

/**
 * Generate synthetic O1280 wind data for a hurricane
 *
 * Wind model:
 * - Cyclonic rotation (counterclockwise in NH, clockwise in SH)
 * - Calm eye (r < eyeRadius)
 * - Peak winds at maxWindRadius (Rankine vortex)
 * - Decay beyond maxWindRadius
 *
 * @param config Hurricane configuration
 * @returns { u, v } wind components on O1280 grid
 */
function generateHurricaneWind(config: HurricaneConfig): WindData {
  const u = new Float32Array(POINTS_PER_TIMESTEP);
  const v = new Float32Array(POINTS_PER_TIMESTEP);

  const hurricaneLat = config.lat * Math.PI / 180;
  const hurricaneLon = config.lon * Math.PI / 180;
  const eyeRadiusRad = config.eyeRadius / EARTH_RADIUS_KM;
  const maxWindRadiusRad = config.maxWindRadius / EARTH_RADIUS_KM;

  // Coriolis sign: positive in NH (counterclockwise), negative in SH
  const coriolisSign = config.lat >= 0 ? 1 : -1;

  let idx = 0;
  for (let ring = 0; ring < 2560; ring++) {
    const latDeg = 90 - (ring + 0.5) * 180 / 2560;
    const lat = latDeg * Math.PI / 180;

    const ringFromPole = ring < 1280 ? ring + 1 : 2560 - ring;
    const nPoints = 4 * ringFromPole + 16;

    for (let i = 0; i < nPoints; i++) {
      const lon = (i / nPoints) * 2 * Math.PI;

      // Great circle distance from hurricane center
      const dLon = lon - hurricaneLon;
      const cosD = Math.sin(hurricaneLat) * Math.sin(lat) +
                   Math.cos(hurricaneLat) * Math.cos(lat) * Math.cos(dLon);
      const dist = Math.acos(Math.max(-1, Math.min(1, cosD)));

      // Bearing from hurricane center to this point
      const y = Math.sin(dLon) * Math.cos(lat);
      const x = Math.cos(hurricaneLat) * Math.sin(lat) -
                Math.sin(hurricaneLat) * Math.cos(lat) * Math.cos(dLon);
      const bearing = Math.atan2(y, x);

      // Wind speed as function of distance (Rankine vortex model)
      let windSpeed = 0;

      if (dist < eyeRadiusRad) {
        // Inside eye: calm center with linear increase to eye wall
        windSpeed = config.maxWindSpeed * (dist / eyeRadiusRad) * 0.3;
      } else if (dist < maxWindRadiusRad) {
        // Eye wall to max wind radius: linear increase
        const t = (dist - eyeRadiusRad) / (maxWindRadiusRad - eyeRadiusRad);
        windSpeed = config.maxWindSpeed * (0.3 + 0.7 * t);
      } else {
        // Beyond max wind radius: decay as 1/r
        windSpeed = config.maxWindSpeed * (maxWindRadiusRad / dist);
      }

      // Tangential wind direction (perpendicular to radial direction)
      // Add 90° (π/2) for counterclockwise in NH, subtract for clockwise in SH
      const windBearing = bearing + coriolisSign * Math.PI / 2;

      // Convert polar wind (speed, direction) to U/V components
      // U: eastward wind (positive = east, negative = west)
      // V: northward wind (positive = north, negative = south)
      u[idx] = windSpeed * Math.sin(windBearing);
      v[idx] = windSpeed * Math.cos(windBearing);

      idx++;
    }
  }

  return { u, v };
}

/**
 * Generate two timesteps of hurricane wind data, 1 hour apart
 *
 * t0: Hurricane at 0°E, 50°N
 * t1: Hurricane at 10°E, 50°N (moved east)
 *
 * @returns Two timesteps with U/V wind components
 */
export function generateHurricaneTestData(): HurricaneTimesteps {
  const baseConfig: HurricaneConfig = {
    lat: 50,
    lon: 0,
    eyeRadius: 50,      // 50km eye
    maxWindRadius: 150, // 150km to peak winds
    maxWindSpeed: 50,   // 50 m/s peak (~100 knots)
  };

  // t0: Hurricane at 0°E, 50°N
  const t0 = generateHurricaneWind(baseConfig);

  // t1: Hurricane at 10°E, 50°N (moved east after 1 hour)
  const t1 = generateHurricaneWind({
    ...baseConfig,
    lon: 10,
  });

  return { t0, t1 };
}
