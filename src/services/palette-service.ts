/**
 * PaletteService - Manages color palettes for data visualization
 *
 * Features:
 * - Load palette JSON files from /images/palettes/
 * - Track active palette per layer
 * - Generate 256x1 RGBA texture data with value-based mapping
 * - Support for both linear and non-linear (log-spaced) palettes
 */

import { signal, effect } from '@preact/signals-core';
import type { RenderService } from './render-service';

// ============================================================
// Types
// ============================================================

export interface PaletteStop {
  value: number | null;
  color: [number, number, number];
  alpha?: number;
}

export type LabelMode = 'value-centered' | 'band-edge' | 'band-range';

export interface PaletteData {
  name: string;
  description?: string;
  unit: string;
  interpolate: boolean;
  labelMode: LabelMode;
  stops: PaletteStop[];
}

interface LayerPalettes {
  available: PaletteData[];
  activeName: string;
}

// ============================================================
// Default palettes (fallback if loading fails)
// ============================================================

const DEFAULT_PALETTES: Record<string, PaletteData> = {
  temp: {
    name: 'Hypatia Temperature',
    unit: 'F',
    interpolate: false,
    labelMode: 'band-edge',
    stops: [
      { value: -60, color: [209, 219, 224] },
      { value: 125, color: [107, 28, 43] },
    ],
  },
};

// ============================================================
// PaletteService
// ============================================================

export class PaletteService {
  /** Palettes per layer: { layer -> { available, activeName } } */
  private layerPalettes = signal<Map<string, LayerPalettes>>(new Map());

  /** Signal that increments when any palette changes (for reactivity) */
  readonly paletteChanged = signal<number>(0);

  private renderService: RenderService;

  constructor(renderService: RenderService) {
    this.renderService = renderService;
  }

  /**
   * Initialize palette reactivity (call after renderer is ready)
   */
  init(): void {
    // Wire up palette reactivity - updates GPU texture when palette changes
    effect(() => {
      void this.paletteChanged.value;
      const palette = this.getPalette('temp');
      const textureData = this.generateTextureData(palette);
      const range = this.getRange(palette);
      this.renderService.updateTempPalette(textureData, range.min, range.max);
    });
  }

  /**
   * Load palette JSON files for a layer from /images/palettes/{layer}-*.json
   * @throws Error if no palettes found (bootstrap should fail fast)
   */
  async loadPalettes(layer: string): Promise<PaletteData[]> {
    const palettes = await this.loadPalettesDirectly(layer);

    if (palettes.length === 0) {
      throw new Error(`[Palette] No palettes found for '${layer}'`);
    }

    // Store loaded palettes
    const current = this.layerPalettes.value;
    const existing = current.get(layer);
    const activeName = existing?.activeName ?? this.getDefaultPaletteName(layer);

    current.set(layer, {
      available: palettes,
      activeName,
    });

    this.layerPalettes.value = new Map(current);
    return palettes;
  }

  /** Load palette files by trying known suffixes */
  private async loadPalettesDirectly(layer: string): Promise<PaletteData[]> {
    const knownSuffixes = ['classic', 'gradient', 'hypatia'];
    const palettes: PaletteData[] = [];

    for (const suffix of knownSuffixes) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}images/palettes/${layer}-${suffix}.json`);
        if (res.ok) {
          const palette = await res.json() as PaletteData;
          palettes.push(palette);
        }
      } catch {
        // Ignore missing files
      }
    }

    return palettes;
  }

  /**
   * Get available palettes for a layer
   */
  getPalettes(layer: string): PaletteData[] {
    const entry = this.layerPalettes.value.get(layer);
    return entry?.available ?? [];
  }

  /**
   * Get active palette for a layer
   */
  getPalette(layer: string): PaletteData {
    const entry = this.layerPalettes.value.get(layer);
    if (!entry) {
      // Return default fallback
      return DEFAULT_PALETTES[layer] ?? {
        name: 'Default',
        unit: '',
        interpolate: true,
        labelMode: 'value-centered',
        stops: [
          { value: 0, color: [0, 0, 0] },
          { value: 1, color: [255, 255, 255] },
        ],
      };
    }

    const active = entry.available.find(p => p.name === entry.activeName);
    if (active) return active;
    if (entry.available[0]) return entry.available[0];
    if (DEFAULT_PALETTES[layer]) return DEFAULT_PALETTES[layer];

    // Final fallback
    return {
      name: 'Default',
      unit: '',
      interpolate: true,
      labelMode: 'value-centered',
      stops: [
        { value: 0, color: [0, 0, 0] },
        { value: 1, color: [255, 255, 255] },
      ],
    };
  }

  /**
   * Set active palette for a layer
   */
  setPalette(layer: string, name: string): void {
    const current = this.layerPalettes.value;
    const entry = current.get(layer);

    if (!entry) {
      console.warn(`[Palette] No palettes loaded for '${layer}'`);
      return;
    }

    const palette = entry.available.find(p => p.name === name);
    if (!palette) {
      console.warn(`[Palette] Palette '${name}' not found for '${layer}'`);
      return;
    }

    entry.activeName = name;
    this.layerPalettes.value = new Map(current);
    this.paletteChanged.value++;
    console.log(`[Palette] Set '${layer}' palette to '${name}'`);
  }

  /**
   * Generate 256x1 RGBA texture data from palette
   * Uses VALUE-BASED mapping in palette's native unit:
   * - Pixel 0 maps to min value (first stop)
   * - Pixel 255 maps to max value (last stop)
   * - Each pixel represents a specific VALUE in the range
   * - Interpolate colors between stops
   */
  generateTextureData(palette: PaletteData): Uint8Array {
    // Use raw palette values (native unit), not converted to Celsius
    const { min, max } = this.getRawRange(palette);
    const data = new Uint8Array(256 * 4); // 256 pixels, RGBA

    for (let i = 0; i < 256; i++) {
      // Map pixel index to value in range [min, max]
      const t = i / 255;
      const value = min + t * (max - min);

      // Find stops surrounding this value
      const color = this.interpolateColor(palette, value);

      data[i * 4 + 0] = color[0];
      data[i * 4 + 1] = color[1];
      data[i * 4 + 2] = color[2];
      data[i * 4 + 3] = color[3];
    }

    return data;
  }

  /**
   * Get raw value range from palette (min/max of stops in native unit)
   */
  getRawRange(palette: PaletteData): { min: number; max: number } {
    const values = palette.stops
      .map(s => s.value)
      .filter((v): v is number => v !== null);

    if (values.length === 0) {
      return { min: 0, max: 1 };
    }

    return {
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  /**
   * Get value range from palette (min/max of stops), converted to Celsius
   */
  getRange(palette: PaletteData): { min: number; max: number } {
    const values = palette.stops
      .map(s => s.value)
      .filter((v): v is number => v !== null);

    if (values.length === 0) {
      return { min: 0, max: 1 };
    }

    let min = Math.min(...values);
    let max = Math.max(...values);

    // Convert Fahrenheit to Celsius if needed (shader expects Celsius)
    if (palette.unit === 'F') {
      min = (min - 32) / 1.8;
      max = (max - 32) / 1.8;
    }

    return { min, max };
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Interpolate color for a specific value
   */
  private interpolateColor(palette: PaletteData, value: number): [number, number, number, number] {
    const stops = palette.stops.filter(s => s.value !== null);

    if (stops.length === 0) {
      return [0, 0, 0, 255];
    }

    // Find surrounding stops
    let lowerStop = stops[0]!;
    let upperStop = stops[stops.length - 1]!;

    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i]!;
      const s2 = stops[i + 1]!;

      if (value >= s1.value! && value <= s2.value!) {
        lowerStop = s1;
        upperStop = s2;
        break;
      }
    }

    // Handle out-of-range values
    if (value <= lowerStop.value!) {
      return [...lowerStop.color, lowerStop.alpha ?? 255];
    }
    if (value >= upperStop.value!) {
      return [...upperStop.color, upperStop.alpha ?? 255];
    }

    // Interpolate between stops
    const range = upperStop.value! - lowerStop.value!;
    const t = range > 0 ? (value - lowerStop.value!) / range : 0;

    if (palette.interpolate) {
      // Linear interpolation
      const r = Math.round(lowerStop.color[0] + t * (upperStop.color[0] - lowerStop.color[0]));
      const g = Math.round(lowerStop.color[1] + t * (upperStop.color[1] - lowerStop.color[1]));
      const b = Math.round(lowerStop.color[2] + t * (upperStop.color[2] - lowerStop.color[2]));
      const a = Math.round(
        (lowerStop.alpha ?? 255) + t * ((upperStop.alpha ?? 255) - (lowerStop.alpha ?? 255))
      );
      return [r, g, b, a];
    }

    // Default: nearest neighbor (no interpolation) - use lower stop color
    return [...lowerStop.color, lowerStop.alpha ?? 255];
  }

  /**
   * Get default palette name for a layer
   */
  private getDefaultPaletteName(layer: string): string {
    const defaults: Record<string, string> = {
      temp: 'Hypatia Temperature',
    };
    return defaults[layer] ?? '';
  }
}
