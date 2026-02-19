/**
 * PaletteService - Unified palette registry and runtime palette management
 *
 * Palette data lives in palettes.json (format-agnostic, message-ready).
 * This module owns types, registry loading, group-based lookup, and
 * runtime state (active palette per layer, texture generation).
 *
 * IMPORTANT: All palette stops use normalized values (0-1).
 * The shader normalizes physical data using param's range [min, max]:
 *   t = (value - min) / (max - min)
 * Then samples the palette texture at t.
 */

import { signal } from '@preact/signals-core';
import palettesJson from '../config/palettes.json';

// ============================================================
// Types
// ============================================================

export interface PaletteStop {
  value: number;               // Normalized 0-1
  color: [number, number, number];
  alpha: number;               // 0-255
}

export interface Palette {
  id: PaletteId;
  name: string;
  description: string;
  groups: string[];
  interpolate: boolean;
  stops: PaletteStop[];
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

// ============================================================
// Registry (static exports for worker + main thread)
// ============================================================

// JSON arrays are number[] — cast via unknown to typed tuples
const raw = palettesJson as unknown as Record<string, Palette>;

// Validate palette IDs match keys
for (const [key, palette] of Object.entries(raw)) {
  if (palette.id !== key) throw new Error(`Palette key "${key}" does not match id "${palette.id}"`);
}

/** All palettes keyed by ID */
export const PALETTES: Record<string, Palette> = raw;

/** All palette IDs in JSON order */
export const PALETTE_IDS = Object.keys(PALETTES);

/** Typed palette ID — derived from JSON keys */
export type PaletteId = keyof typeof palettesJson;

/** Get palette by ID (throws if unknown) */
export function getPalette(id: string): Palette {
  const palette = PALETTES[id];
  if (!palette) throw new Error(`Unknown palette: ${id}`);
  return palette;
}

/** Type guard for palette IDs */
export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && value in PALETTES;
}

/** Get all palettes belonging to a group */
export function getPalettesByGroup(group: string): Palette[] {
  return Object.values(PALETTES).filter(p => p.groups.includes(group));
}

/** Get palette IDs for a group (for Zod enums) */
export function getPaletteIdsByGroup(group: string): PaletteId[] {
  return getPalettesByGroup(group).map(p => p.id);
}

// ============================================================
// Registry → PaletteData conversion
// ============================================================

function toPaletteData(palette: Palette): PaletteData {
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

/** All palettes as PaletteData, cached once */
const ALL_PALETTE_DATA: PaletteData[] = Object.values(PALETTES).map(toPaletteData);

// ============================================================
// PaletteService
// ============================================================

export class PaletteService {
  /** Active palette ID per layer */
  private activePalettes = signal<Map<string, PaletteId>>(new Map());

  /** Signal that increments when any palette changes (for reactivity) */
  readonly paletteChanged = signal<number>(0);

  /**
   * Get available palettes for a layer (by group)
   */
  getPalettes(group: string): PaletteData[] {
    return ALL_PALETTE_DATA.filter(p => {
      const reg = PALETTES[p.id];
      return reg && reg.groups.includes(group);
    });
  }

  /**
   * Get active palette for a layer
   */
  getPalette(group: string): PaletteData {
    const activeId = this.activePalettes.value.get(group);
    if (activeId) {
      const palette = PALETTES[activeId];
      if (palette) return toPaletteData(palette);
    }

    // Fallback to first palette in group
    const groupPalettes = getPalettesByGroup(group);
    if (groupPalettes.length > 0) {
      return toPaletteData(groupPalettes[0]!);
    }
    throw new Error(`[Palette] No palettes found for group '${group}'`);
  }

  /**
   * Set active palette for a layer by ID
   */
  setPalette(layer: string, id: PaletteId): void {
    if (!(id in PALETTES)) {
      console.warn(`[Palette] Unknown palette '${id}'`);
      return;
    }

    const current = new Map(this.activePalettes.value);
    current.set(layer, id);
    this.activePalettes.value = current;
    this.paletteChanged.value++;
  }

  /**
   * Get palette by ID from registry
   */
  getPaletteById(id: string): PaletteData | undefined {
    const palette = PALETTES[id];
    return palette ? toPaletteData(palette) : undefined;
  }
}
