/**
 * PaletteService - Manages color palettes for data visualization
 *
 * Features:
 * - Unified palette registry (src/config/palettes.ts)
 * - Track active palette per layer
 * - Generate 256x1 RGBA texture data with value-based mapping
 * - Support for both linear and non-linear (log-spaced) palettes
 */

import { signal } from '@preact/signals-core';
import { PALETTES, getPalettesByPrefix, type Palette, type PaletteId } from '../config/palettes';

// ============================================================
// Types
// ============================================================

export interface PaletteStop {
  value: number;               // Normalized 0-1
  color: [number, number, number];
  alpha: number;               // 0-255
}

export type LabelMode = 'value-centered' | 'band-edge' | 'band-range';

export interface PaletteData {
  id: PaletteId;
  name: string;
  description?: string;
  interpolate: boolean;
  labelMode: LabelMode;
  stops: PaletteStop[];
}

interface LayerPalettes {
  available: PaletteData[];
  activeId: string;
}

// ============================================================
// Registry → PaletteData conversion
// ============================================================

function registryToPaletteData(palette: Palette): PaletteData {
  return {
    id: palette.id,
    name: palette.name,
    description: palette.description,
    interpolate: palette.interpolate,
    labelMode: palette.interpolate ? 'value-centered' : 'band-edge',
    stops: palette.stops.map(s => ({
      value: s.value,
      color: s.color,
      alpha: s.alpha,
    })),
      };
}

// ============================================================
// PaletteService
// ============================================================

export class PaletteService {
  /** Palettes per layer: { layer -> { available, activeId } } */
  private layerPalettes = signal<Map<string, LayerPalettes>>(new Map());

  /** Signal that increments when any palette changes (for reactivity) */
  readonly paletteChanged = signal<number>(0);

  /**
   * Load palettes for a layer from the registry
   * Palettes are matched by prefix (e.g., 'temp' matches 'temp-classic', 'temp-hypatia')
   * @throws Error if no palettes found (bootstrap should fail fast)
   */
  async loadPalettes(layer: string): Promise<PaletteData[]> {
    const registryPalettes = getPalettesByPrefix(layer);
    const palettes = registryPalettes.map(registryToPaletteData);

    if (palettes.length === 0) {
      throw new Error(`[Palette] No palettes found for '${layer}'`);
    }

    // Store loaded palettes
    const current = this.layerPalettes.value;
    const existing = current.get(layer);
    const activeId = existing?.activeId ?? palettes[0]!.id;

    current.set(layer, {
      available: palettes,
      activeId,
    });

    this.layerPalettes.value = new Map(current);
    return palettes;
  }

  /**
   * Get available palettes for a layer
   */
  getPalettes(layer: string): PaletteData[] {
    const entry = this.layerPalettes.value.get(layer);
    return entry?.available ?? []; // QC-OK: may be called before load
  }

  /**
   * Get active palette for a layer
   */
  getPalette(layer: string): PaletteData {
    const entry = this.layerPalettes.value.get(layer);
    if (!entry) {
      // Try registry directly as fallback
      const registryPalettes = getPalettesByPrefix(layer);
      if (registryPalettes.length > 0) {
        return registryToPaletteData(registryPalettes[0]!);
      }
      throw new Error(`[Palette] No palettes found for layer '${layer}'`);
    }

    const active = entry.available.find(p => p.id === entry.activeId);
    if (active) return active;
    if (entry.available[0]) return entry.available[0];

    throw new Error(`[Palette] No available palettes for layer '${layer}'`);
  }

  /**
   * Set active palette for a layer by ID
   */
  setPalette(layer: string, id: PaletteId): void {
    const current = this.layerPalettes.value;
    const entry = current.get(layer);

    if (!entry) {
      console.warn(`[Palette] No palettes loaded for '${layer}'`);
      return;
    }

    const palette = entry.available.find(p => p.id === id);
    if (!palette) {
      console.warn(`[Palette] Palette '${id}' not found for '${layer}'`);
      return;
    }

    entry.activeId = id;
    this.layerPalettes.value = new Map(current);
    this.paletteChanged.value++;
  }

  /**
   * Generate 256x1 RGBA texture data from palette
   * Palette stops use normalized values (0-1).
   * Pixel i maps to t = i/255, colors interpolated between stops.
   */
  generateTextureData(palette: PaletteData): Uint8Array {
    const data = new Uint8Array(256 * 4);

    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const color = this.interpolateColor(palette, t);
      data[i * 4 + 0] = color[0];
      data[i * 4 + 1] = color[1];
      data[i * 4 + 2] = color[2];
      data[i * 4 + 3] = color[3];
    }

    return data;
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Interpolate color for a normalized value (0-1)
   */
  private interpolateColor(palette: PaletteData, t: number): [number, number, number, number] {
    const stops = palette.stops;

    if (stops.length === 0) {
      return [0, 0, 0, 255];
    }

    // Find surrounding stops
    let lowerStop = stops[0]!;
    let upperStop = stops[stops.length - 1]!;

    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i]!;
      const s2 = stops[i + 1]!;

      if (t >= s1.value && t <= s2.value) {
        lowerStop = s1;
        upperStop = s2;
        break;
      }
    }

    // Handle out-of-range values
    if (t <= lowerStop.value) {
      return [...lowerStop.color, lowerStop.alpha];
    }
    if (t >= upperStop.value) {
      return [...upperStop.color, upperStop.alpha];
    }

    // Interpolate between stops
    const range = upperStop.value - lowerStop.value;
    const frac = range > 0 ? (t - lowerStop.value) / range : 0;

    if (palette.interpolate) {
      const r = Math.round(lowerStop.color[0] + frac * (upperStop.color[0] - lowerStop.color[0]));
      const g = Math.round(lowerStop.color[1] + frac * (upperStop.color[1] - lowerStop.color[1]));
      const b = Math.round(lowerStop.color[2] + frac * (upperStop.color[2] - lowerStop.color[2]));
      const a = Math.round(lowerStop.alpha + frac * (upperStop.alpha - lowerStop.alpha));
      return [r, g, b, a];
    }

    // Stepped: use lower stop color
    return [...lowerStop.color, lowerStop.alpha];
  }

  /**
   * Get palette by ID from registry
   */
  getPaletteById(id: string): PaletteData | undefined {
    const palette = PALETTES[id];
    return palette ? registryToPaletteData(palette) : undefined;
  }

  /**
   * Get all available palette IDs
   */
  getAllPaletteIds(): string[] {
    return Object.keys(PALETTES);
  }

  /**
   * Get normalized range (always 0-1 since palettes are normalized)
   * @deprecated Use param metadata for physical range
   */
  getRange(_palette: PaletteData): { min: number; max: number } {
    return { min: 0, max: 1 };
  }
}
