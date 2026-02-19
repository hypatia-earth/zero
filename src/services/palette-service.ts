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
import type { ZeroOptions } from '../schemas/options.schema';

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

// ============================================================
// Registry (static exports for worker + main thread)
// ============================================================

/** Typed palette ID — derived from JSON keys */
export type PaletteId = keyof typeof palettesJson;

// Build typed registry from JSON — only cast is color tuple (inherent to JSON imports)
const PALETTES: Record<PaletteId, Palette> = Object.fromEntries(
  Object.entries(palettesJson).map(([key, raw]) => {
    if (raw.id !== key) throw new Error(`Palette key "${key}" does not match id "${raw.id}"`);
    return [key, {
      id: key as PaletteId,
      name: raw.name,
      description: raw.description,
      groups: raw.groups,
      interpolate: raw.interpolate,
      stops: raw.stops.map(s => ({
        value: s.value,
        color: s.color as [number, number, number],
        alpha: s.alpha,
      })),
    }];
  })
) as Record<PaletteId, Palette>;

export { PALETTES };

/** All palette IDs in JSON order */
export const PALETTE_IDS: PaletteId[] = Object.keys(PALETTES) as PaletteId[];

/** Get palette by ID (throws if unknown) */
export function getPalette(id: PaletteId): Palette {
  return PALETTES[id];
}

/** Derive label mode from palette interpolation setting */
export function getLabelMode(palette: Palette): LabelMode {
  return palette.interpolate ? 'value-centered' : 'band-edge';
}

/** Type guard for palette IDs */
export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && value in PALETTES;
}

/** Get all palettes belonging to a group */
export function getPalettesByGroup(group: string): Palette[] {
  return Object.values(PALETTES).filter(p => p.groups.includes(group));
}

/** Get palette IDs for a group */
export function getPaletteIdsByGroup(group: string): PaletteId[] {
  return getPalettesByGroup(group).map(p => p.id);
}

/** Get palette IDs as non-empty tuple (for Zod enums). Throws if group has no palettes. */
export function getPaletteIdsEnum(group: string): [PaletteId, ...PaletteId[]] {
  const ids = getPaletteIdsByGroup(group);
  if (ids.length === 0) throw new Error(`No palettes for group '${group}'`);
  const [first, ...rest] = ids;
  return [first!, ...rest];
}

// ============================================================
// PaletteService
// ============================================================

export class PaletteService {
  /** Active palette ID per layer */
  private activePalettes = signal<Map<string, PaletteId>>(new Map());

  /** Signal that increments when any palette changes (for reactivity) */
  readonly paletteChanged = signal<number>(0);

  /**
   * Restore persisted palette selections from options object.
   * Scans for any `*.palette` field that is a valid PaletteId.
   */
  restoreFromOptions(options: ZeroOptions): void {
    for (const [group, layerOpts] of Object.entries(options)) {
      if (typeof layerOpts === 'object' && layerOpts !== null && 'palette' in layerOpts && isPaletteId(layerOpts.palette)) {
        this.setPalette(group, layerOpts.palette);
      }
    }
  }

  /**
   * Get available palettes for a layer (by group)
   */
  getPalettes(group: string): Palette[] {
    return getPalettesByGroup(group);
  }

  /**
   * Get active palette for a layer
   */
  getActivePalette(group: string): Palette {
    const activeId = this.activePalettes.value.get(group);
    if (activeId) return PALETTES[activeId];

    // Fallback to first palette in group
    const groupPalettes = getPalettesByGroup(group);
    if (groupPalettes.length > 0) return groupPalettes[0]!;
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
   * Get palette by ID from registry (accepts string for boundary use)
   */
  getPaletteById(id: string): Palette | undefined {
    return PALETTES[id as PaletteId];
  }
}
