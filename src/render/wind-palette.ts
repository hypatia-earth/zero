/**
 * Wind Speed Color Palette
 *
 * Creates a 256-entry RGBA color palette for wind speed visualization.
 * Maps wind speeds from 0 m/s (white/light) to 50+ m/s (deep red).
 *
 * Color progression:
 * - 0 m/s: White/light gray
 * - 0-10 m/s: Light blue → Cyan (light breeze to fresh breeze)
 * - 10-20 m/s: Green → Yellow (strong breeze to gale)
 * - 20-35 m/s: Orange → Red (storm to hurricane)
 * - 35-50+ m/s: Deep red → Magenta (violent storm)
 */

interface ColorStop {
  speed: number; // m/s
  r: number;
  g: number;
  b: number;
  a: number;
}

const WIND_SPEED_STOPS: ColorStop[] = [
  // 0 m/s - White (calm)
  { speed: 0, r: 245, g: 245, b: 245, a: 255 },

  // 5 m/s - Light blue (light breeze)
  { speed: 5, r: 200, g: 230, b: 255, a: 255 },

  // 10 m/s - Cyan (fresh breeze)
  { speed: 10, r: 100, g: 220, b: 255, a: 255 },

  // 15 m/s - Light green (strong breeze)
  { speed: 15, r: 120, g: 240, b: 120, a: 255 },

  // 20 m/s - Yellow-green (near gale)
  { speed: 20, r: 200, g: 255, b: 100, a: 255 },

  // 25 m/s - Yellow (gale)
  { speed: 25, r: 255, g: 255, b: 80, a: 255 },

  // 30 m/s - Orange (strong gale/storm)
  { speed: 30, r: 255, g: 180, b: 60, a: 255 },

  // 35 m/s - Red-orange (violent storm)
  { speed: 35, r: 255, g: 100, b: 50, a: 255 },

  // 40 m/s - Red (hurricane force)
  { speed: 40, r: 230, g: 40, b: 40, a: 255 },

  // 50 m/s - Deep red (violent hurricane)
  { speed: 50, r: 180, g: 0, b: 20, a: 255 },

  // 60+ m/s - Magenta (extreme)
  { speed: 60, r: 200, g: 0, b: 100, a: 255 },
];

const MAX_SPEED = 50; // m/s - maximum speed for normalization

/**
 * Linear interpolation between two values
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Find color stops surrounding a given speed
 */
function findStops(speed: number): [ColorStop, ColorStop, number] {
  const first = WIND_SPEED_STOPS[0]!;
  const last = WIND_SPEED_STOPS[WIND_SPEED_STOPS.length - 1]!;

  // Handle edge cases
  if (speed <= first.speed) {
    return [first, first, 0];
  }
  if (speed >= last.speed) {
    return [last, last, 0];
  }

  // Find surrounding stops
  for (let i = 0; i < WIND_SPEED_STOPS.length - 1; i++) {
    const stop1 = WIND_SPEED_STOPS[i]!;
    const stop2 = WIND_SPEED_STOPS[i + 1]!;

    if (speed >= stop1.speed && speed <= stop2.speed) {
      const range = stop2.speed - stop1.speed;
      const t = range > 0 ? (speed - stop1.speed) / range : 0;
      return [stop1, stop2, t];
    }
  }

  // Fallback (should never reach here)
  return [first, first, 0];
}

/**
 * Interpolate color for a given wind speed
 */
function interpolateColor(speed: number): [number, number, number, number] {
  const [stop1, stop2, t] = findStops(speed);

  const r = Math.round(lerp(stop1.r, stop2.r, t));
  const g = Math.round(lerp(stop1.g, stop2.g, t));
  const b = Math.round(lerp(stop1.b, stop2.b, t));
  const a = Math.round(lerp(stop1.a, stop2.a, t));

  return [r, g, b, a];
}

/**
 * Create a 256-entry RGBA wind speed palette
 *
 * @returns Uint8Array of 1024 bytes (256 pixels × 4 channels)
 *
 * Maps palette indices to wind speeds:
 * - Index 0 → 0 m/s (white)
 * - Index 255 → 50 m/s (deep red/magenta)
 * - Linear mapping between
 */
export function createWindPalette(): Uint8Array {
  const data = new Uint8Array(256 * 4); // 256 pixels, RGBA

  for (let i = 0; i < 256; i++) {
    // Map index to wind speed [0, MAX_SPEED]
    const speed = (i / 255) * MAX_SPEED;

    // Get interpolated color
    const [r, g, b, a] = interpolateColor(speed);

    // Write RGBA values
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }

  return data;
}
