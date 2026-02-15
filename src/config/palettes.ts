/**
 * Unified Palette Registry
 *
 * Single source of truth for all color palettes.
 * Palettes can be used by any layer via withPalettes().
 *
 * IMPORTANT: All palette stops use normalized values (0-1).
 * The shader normalizes physical data using param's range [min, max]:
 *   t = (value - min) / (max - min)
 * Then samples the palette texture at t.
 */

export interface PaletteStop {
  value: number;               // Normalized 0-1
  color: [number, number, number];
  alpha: number;               // 0-255
}

export interface Palette {
  id: string;
  name: string;
  description: string;
  interpolate: boolean;        // true = smooth gradient, false = stepped bands
  stops: PaletteStop[];
}

export const PALETTES: Record<string, Palette> = {
  // ─────────────────────────────────────────────────────────────────────────
  // Temperature Palettes
  // ─────────────────────────────────────────────────────────────────────────

  'temp-classic': {
    id: 'temp-classic',
    name: 'Classic Temperature',
    description: 'Meaningful palette with dark freezing wall',
    interpolate: false,
    stops: [
      { value: 0.00, color: [209, 219, 224], alpha: 255 },
      { value: 0.10, color: [163, 184, 199], alpha: 255 },
      { value: 0.20, color: [102, 133, 158], alpha: 255 },
      { value: 0.30, color: [61, 92, 133], alpha: 255 },
      { value: 0.40, color: [32, 48, 87], alpha: 255 },     // Freezing wall
      { value: 0.45, color: [41, 77, 115], alpha: 255 },
      { value: 0.50, color: [61, 117, 148], alpha: 255 },
      { value: 0.55, color: [97, 140, 133], alpha: 255 },
      { value: 0.60, color: [133, 153, 107], alpha: 255 },
      { value: 0.65, color: [158, 158, 92], alpha: 255 },
      { value: 0.70, color: [184, 153, 82], alpha: 255 },
      { value: 0.75, color: [209, 122, 61], alpha: 255 },
      { value: 0.80, color: [217, 84, 56], alpha: 255 },
      { value: 0.90, color: [199, 56, 82], alpha: 255 },
      { value: 1.00, color: [107, 28, 43], alpha: 255 },
    ],
  },

  'temp-hypatia': {
    id: 'temp-hypatia',
    name: 'Hypatia Temperature',
    description: 'Original Hypatia gradient from purple to red',
    interpolate: false,
    stops: [
      { value: 0.00, color: [170, 102, 170], alpha: 255 },
      { value: 0.15, color: [206, 155, 229], alpha: 255 },
      { value: 0.30, color: [118, 206, 226], alpha: 255 },
      { value: 0.45, color: [108, 239, 108], alpha: 255 },
      { value: 0.55, color: [237, 249, 108], alpha: 255 },
      { value: 0.70, color: [255, 187, 85], alpha: 255 },
      { value: 0.85, color: [251, 101, 78], alpha: 255 },
      { value: 1.00, color: [204, 64, 64], alpha: 255 },
    ],
  },

  'temp-gradient': {
    id: 'temp-gradient',
    name: 'Simple Gradient',
    description: 'Simple blue to red linear gradient',
    interpolate: true,
    stops: [
      { value: 0.0, color: [0, 0, 255], alpha: 255 },
      { value: 0.2, color: [0, 200, 255], alpha: 255 },
      { value: 0.4, color: [0, 255, 128], alpha: 255 },
      { value: 0.5, color: [128, 255, 0], alpha: 255 },
      { value: 0.6, color: [255, 255, 0], alpha: 255 },
      { value: 0.8, color: [255, 128, 0], alpha: 255 },
      { value: 1.0, color: [255, 0, 0], alpha: 255 },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Wind Palette
  // ─────────────────────────────────────────────────────────────────────────

  'wind-speed': {
    id: 'wind-speed',
    name: 'Wind Speed',
    description: 'Calm white to storm red',
    interpolate: true,
    stops: [
      { value: 0.00, color: [245, 245, 245], alpha: 0 },    // Calm
      { value: 0.12, color: [200, 230, 255], alpha: 89 },   // Light breeze
      { value: 0.22, color: [100, 220, 255], alpha: 166 },  // Fresh breeze
      { value: 0.34, color: [255, 180, 180], alpha: 255 },  // Gale
      { value: 0.40, color: [255, 100, 100], alpha: 255 },  // Strong gale
      { value: 0.48, color: [230, 50, 50], alpha: 255 },    // Storm
      { value: 0.60, color: [200, 30, 30], alpha: 255 },    // Violent storm
      { value: 0.80, color: [170, 0, 20], alpha: 255 },     // Hurricane
      { value: 1.00, color: [140, 0, 30], alpha: 255 },     // Extreme
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Rain Palettes
  // ─────────────────────────────────────────────────────────────────────────

  'rain-intensity': {
    id: 'rain-intensity',
    name: 'Rain Intensity',
    description: 'Blue gradient for precipitation intensity',
    interpolate: true,
    stops: [
      { value: 0.00, color: [10, 61, 150], alpha: 0 },      // None
      { value: 0.10, color: [10, 61, 150], alpha: 77 },     // Light
      { value: 0.25, color: [46, 92, 168], alpha: 128 },
      { value: 0.40, color: [82, 125, 189], alpha: 153 },
      { value: 0.60, color: [99, 140, 196], alpha: 166 },
      { value: 0.80, color: [120, 158, 207], alpha: 179 },
      { value: 1.00, color: [200, 220, 255], alpha: 200 },  // Heavy
    ],
  },

  'rain-type': {
    id: 'rain-type',
    name: 'Precipitation Type',
    description: 'Categorical: rain, snow, mix',
    interpolate: false,
    stops: [
      { value: 0.00, color: [0, 0, 0], alpha: 0 },
      { value: 0.33, color: [77, 128, 255], alpha: 255 },
      { value: 0.66, color: [230, 242, 255], alpha: 255 },
      { value: 1.00, color: [153, 102, 204], alpha: 255 },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud Palette
  // ─────────────────────────────────────────────────────────────────────────

  'cloud-cover': {
    id: 'cloud-cover',
    name: 'Cloud Cover',
    description: 'Transparent to white for cloud coverage',
    interpolate: true,
    stops: [
      { value: 0.0, color: [255, 255, 255], alpha: 0 },     // Clear
      { value: 0.5, color: [240, 240, 245], alpha: 128 },   // Partial
      { value: 1.0, color: [220, 220, 230], alpha: 230 },   // Overcast
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Pressure Palette
  // ─────────────────────────────────────────────────────────────────────────

  'pressure-gradient': {
    id: 'pressure-gradient',
    name: 'Pressure Gradient',
    description: 'Blue (low) → white (1012) → red (high)',
    interpolate: true,
    stops: [
      { value: 0.0, color: [100, 150, 255], alpha: 255 },
      { value: 0.5, color: [255, 255, 255], alpha: 255 },
      { value: 1.0, color: [255, 100, 100], alpha: 255 },
    ],
  },
};

// Helper: get all palette IDs
export const PALETTE_IDS = Object.keys(PALETTES);

// Helper: get palette by ID (throws if not found)
export function getPalette(id: string): Palette {
  const palette = PALETTES[id];
  if (!palette) throw new Error(`Unknown palette: ${id}`);
  return palette;
}

// Helper: get palettes for a category
export function getPalettesByPrefix(prefix: string): Palette[] {
  return Object.values(PALETTES).filter(p => p.id.startsWith(prefix));
}
