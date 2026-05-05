/**
 * Palette types — aurora consumes registered palettes and assigns runtime ids.
 */

export interface PaletteStop {
  value: number;
  rgba: [number, number, number, number];
}

export interface Palette {
  id: string;
  stops: PaletteStop[];
  normalization: 'linear' | 'log' | 'discrete';
}

/** Numeric handle assigned by aurora at registration; used in shaders/uniforms. */
export type PaletteRuntimeId = number;
