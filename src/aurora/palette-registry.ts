/**
 * Palette registry — aurora-internal store for palettes injected via
 * aurora.init({palettes}). Insertion order is the canonical row order
 * for the GPU palette texture (palette-texture.ts) and any callers
 * that scan palettes by index.
 */

import type { Palette, PaletteId } from './types/palette';

const registry = new Map<PaletteId, Palette>();
let orderedIds: PaletteId[] = [];

export function setPalettes(palettes: Palette[]): void {
  registry.clear();
  orderedIds = [];
  for (const p of palettes) {
    registry.set(p.id, p);
    orderedIds.push(p.id);
  }
}

export function getPalette(id: PaletteId): Palette {
  const p = registry.get(id);
  if (!p) throw new Error(`palette-registry: unknown palette '${id}'`);
  return p;
}

export function getPaletteIds(): readonly PaletteId[] {
  return orderedIds;
}

export function getPaletteCount(): number {
  return orderedIds.length;
}

export function isStepped(id: PaletteId): boolean {
  return !getPalette(id).interpolate;
}
