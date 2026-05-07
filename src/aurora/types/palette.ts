/**
 * Palette types — aurora's render-time palette shape.
 *
 * Host injects `Palette[]` via `aurora.init({palettes})`; aurora indexes them
 * in registration order and uses that index as a row in the GPU palette
 * texture. All stops are normalized 0..1 and sampled by shaders against a
 * per-param [min, max] range.
 */

export interface PaletteStop {
  /** Normalized 0..1 along the palette. */
  value: number;
  /** rgb 0..255. */
  color: [number, number, number];
  /** alpha 0..255. */
  alpha: number;
}

export interface Palette {
  id: string;
  name: string;
  description: string;
  groups: string[];
  /** false = stepped; true = linear interpolation between stops. */
  interpolate: boolean;
  stops: PaletteStop[];
}

/** Opaque string handle. Aurora-side identity is by string id, not numeric runtime id. */
export type PaletteId = string;
