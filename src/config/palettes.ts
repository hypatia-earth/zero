/**
 * Unified Palette Registry
 *
 * Palette data lives in palettes.json (format-agnostic, message-ready).
 * This module applies TypeScript types and re-exports the typed API.
 *
 * IMPORTANT: All palette stops use normalized values (0-1).
 * The shader normalizes physical data using param's range [min, max]:
 *   t = (value - min) / (max - min)
 * Then samples the palette texture at t.
 */

import palettesJson from './palettes.json';

export interface PaletteStop {
  value: number;               // Normalized 0-1
  color: [number, number, number];
  alpha: number;               // 0-255
}

export interface Palette {
  id: PaletteId;
  name: string;
  description: string;
  interpolate: boolean;        // true = smooth gradient, false = stepped bands
  stops: PaletteStop[];
}

// JSON arrays are number[] — cast via unknown to typed tuples
const raw = palettesJson as unknown as Record<string, Palette>;

// Validate palette IDs match keys
for (const [key, palette] of Object.entries(raw)) {
  if (palette.id !== key) throw new Error(`Palette key "${key}" does not match id "${palette.id}"`);
}

export const PALETTES: Record<string, Palette> = raw;
export const PALETTE_IDS = Object.keys(PALETTES);

// Typed palette ID — derived from JSON keys
export type PaletteId = keyof typeof palettesJson;

// Palette IDs by prefix for z.enum() — must be const tuples for Zod to infer literal types
export const TEMP_PALETTE_IDS = ['temp-classic', 'temp-hypatia', 'temp-gradient'] as const satisfies readonly PaletteId[];
export const RAIN_PALETTE_IDS = ['rain-intensity', 'rain-type'] as const satisfies readonly PaletteId[];
export const WIND_PALETTE_IDS = ['wind-speed'] as const satisfies readonly PaletteId[];

export function getPalette(id: string): Palette {
  const palette = PALETTES[id];
  if (!palette) throw new Error(`Unknown palette: ${id}`);
  return palette;
}

export function getPalettesByPrefix(prefix: string): Palette[] {
  return Object.values(PALETTES).filter(p => p.id.startsWith(prefix));
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && value in PALETTES;
}
