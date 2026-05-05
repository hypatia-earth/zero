/**
 * Aurora option types — engine-wide and per-layer.
 *
 * Sub-B Phase 1 introduces these types as the public option surface.
 * Phases 4 & 5 wire them through aurora-db persistence and typed setters.
 *
 * Three option groups (per parent plan):
 *   1. Host options — owned by Zero/Aether, persisted in host's IDB, never enters aurora.
 *   2. Engine options (`EngineOpts`) — aurora-wide, persisted in aurora-db.
 *   3. Layer options (`LayersOpts`) — per-layer, keyed by layer id, persisted in aurora-db.
 */

import type { PaletteRuntimeId } from './palette';

// ─── Engine-wide options ─────────────────────────────────────────────────────

export interface EngineOpts {
  timeslotsPerLayer: number;
  useTimestampQueries: boolean;
  qualityScale?: number;
  debug?: {
    wireframe: boolean;
    axes: boolean;
    overdraw: boolean;
  };
}

// ─── Per-layer options (discriminated by layer id at call sites) ─────────────

export interface WindOpts {
  snakeLength: number;
  lineWidth: number;
  segmentsPerLine: number;
  stepFactor: number;
  radius: number;
  animSpeed: number;
  particleCount: number;
}

export interface PressureOpts {
  isobarSpacing: number;        // hPa
  smoothing: number;            // 0..1
  colorScheme: 'altitude' | 'gradient' | 'solid';
}

export interface GraticuleOpts {
  fontSize: number;             // CSS px (aurora applies DPR scaling)
  lineWidth: number;            // CSS px
  lodLevels: { spacing: number; zoomInPx: number; zoomOutPx: number }[];
}

export interface CitiesOpts {
  fontScale: number;
  tierThresholds: number[];
}

/** Shared shape for scalar-field layers (temp, rain, clouds, ocean-temp, sea-ice, wet-bulb). */
export interface ScalarFieldOpts {
  paletteId: PaletteRuntimeId;
  range: [number, number];
  blendMode: 'normal' | 'multiply' | 'screen';
}

// ─── Layer entry + map ───────────────────────────────────────────────────────

export interface LayerEntry<T = unknown> {
  opacity: number;              // 0..1
  opts: T;
}

export type LayersOpts = Record<string, LayerEntry>;
//                       ↑ keyed by layer id; opts type narrowed by id at adapter sites.

// ─── Top-level Aurora options ────────────────────────────────────────────────

export interface AuroraOptions {
  engine: EngineOpts;
  layers: LayersOpts;
}
