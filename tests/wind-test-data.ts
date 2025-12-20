/**
 * Synthetic O1280 wind data generator for testing
 * Generates wind field with multiple zones:
 * - Hurricane (cyclonic rotation)
 * - Calm zone (doldrums)
 * - Slow wind (trade winds)
 * - Fast wind (jet stream)
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
  u: Float32Array;  // U component (m/s, eastward positive)
  v: Float32Array;  // V component (m/s, northward positive)
}

export interface HurricaneTimesteps {
  t0: WindData;
  t1: WindData;
}

/**
 * Base wind field with distinct zones for T6 snake animation testing
 * - Doldrums (0-10°N, Pacific): ~0 m/s
 * - Trade winds (10-30°N): ~8 m/s easterly
 * - Westerlies (30-60°N): ~15 m/s westerly
 * - Jet stream (40-50°N, Atlantic): ~40 m/s westerly
 */
function getBaseWind(latDeg: number, lonDeg: number): { u: number; v: number } {
  // Normalize longitude to 0-360
  let lon = lonDeg;
  if (lon < 0) lon += 360;

  // Doldrums: Equatorial Pacific (0-10°N, 150°W-90°W = 210-270°E)
  if (latDeg >= -5 && latDeg <= 10 && lon >= 180 && lon <= 280) {
    return { u: 0, v: 0 };  // Calm
  }

  // Trade winds: 10-30° both hemispheres (easterly)
  if (Math.abs(latDeg) >= 10 && Math.abs(latDeg) <= 30) {
    const sign = latDeg > 0 ? -1 : 1;  // NE trades in NH, SE trades in SH
    return { u: -8, v: sign * 3 };  // ~8 m/s from east
  }

  // Jet stream: 40-50°N over Atlantic (30°W-10°E = 330-10°E)
  if (latDeg >= 35 && latDeg <= 55 && (lon >= 300 || lon <= 30)) {
    // Strong westerly jet
    const jetCore = 1 - Math.abs(latDeg - 45) / 10;  // Peak at 45°N
    return { u: 40 * jetCore, v: 0 };  // Up to 40 m/s
  }

  // Westerlies: 30-60° both hemispheres
  if (Math.abs(latDeg) >= 30 && Math.abs(latDeg) <= 60) {
    return { u: 12, v: 0 };  // ~12 m/s from west
  }

  // Default: light variable winds
  return { u: 2, v: 1 };
}

/**
 * Generate synthetic O1280 wind data with base wind field + hurricane
 *
 * Wind model:
 * - Base wind field (doldrums, trades, westerlies, jet stream)
 * - Hurricane overlay with cyclonic rotation
 * - Calm eye (r < eyeRadius)
 * - Peak winds at maxWindRadius (Rankine vortex)
 * - Decay beyond maxWindRadius
 *
 * @param config Hurricane configuration
 * @returns { u, v } wind components
 */
function generateHurricaneWind(config: HurricaneConfig): WindData {
  const u = new Float32Array(POINTS_PER_TIMESTEP);
  const v = new Float32Array(POINTS_PER_TIMESTEP);

  const hurricaneLat = config.lat * Math.PI / 180;
  const hurricaneLon = config.lon * Math.PI / 180;
  const eyeRadiusRad = config.eyeRadius / EARTH_RADIUS_KM;
  const maxWindRadiusRad = config.maxWindRadius / EARTH_RADIUS_KM;
  const influenceRadiusRad = maxWindRadiusRad * 3;  // Hurricane influence extends 3x max wind radius

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
      const lonDeg = (lon * 180 / Math.PI);

      // Start with base wind field
      const base = getBaseWind(latDeg, lonDeg);
      let windU = base.u;
      let windV = base.v;

      // Great circle distance from hurricane center
      const dLon = lon - hurricaneLon;
      const cosD = Math.sin(hurricaneLat) * Math.sin(lat) +
                   Math.cos(hurricaneLat) * Math.cos(lat) * Math.cos(dLon);
      const dist = Math.acos(Math.max(-1, Math.min(1, cosD)));

      // Add hurricane wind if within influence radius
      if (dist < influenceRadiusRad) {
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

        // Blend factor: hurricane dominates near center, fades at edge
        const blendFactor = 1 - Math.pow(dist / influenceRadiusRad, 2);

        // Tangential wind direction (perpendicular to radial direction)
        const windBearing = bearing + coriolisSign * Math.PI / 2;

        // Blend hurricane wind with base wind
        const hurricaneU = windSpeed * Math.sin(windBearing);
        const hurricaneV = windSpeed * Math.cos(windBearing);
        windU = windU * (1 - blendFactor) + hurricaneU * blendFactor;
        windV = windV * (1 - blendFactor) + hurricaneV * blendFactor;
      }

      // Store U/V directly
      u[idx] = windU;
      v[idx] = windV;
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
