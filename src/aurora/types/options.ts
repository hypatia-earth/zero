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

// ─── Engine-wide options ─────────────────────────────────────────────────────

export interface EngineOpts {
  timeslotsPerLayer: number;
  useTimestampQueries: boolean;
  qualityScale?: number;
  /** Show host-supplied logo overlay when no layers are visible. Optional —
   *  hosts that don't ship a logo simply leave it false (the default). */
  showLogo?: boolean;
  debug?: {
    wireframe: boolean;
    axes: boolean;
    overdraw: boolean;
  };
}

// ─── Per-layer options ───────────────────────────────────────────────────────
// Worker-side host opts (WindHostOpts/PressureHostOpts/CitiesHostOpts/
// TempHostOpts/RainHostOpts) live inline in `aurora/worker.ts`. The dialog
// drives the dispatched shapes; the discriminated-by-id setLayerOptions
// path narrows at the call site rather than via top-level types.
//
// GraticuleOpts is the lone export still consumed (the worker `Pick`s
// `fontSize | lineWidth` from it).

export interface GraticuleOpts {
  fontSize: number;             // CSS px (aurora applies DPR scaling)
  lineWidth: number;            // CSS px
  lodLevels: { spacing: number; zoomInPx: number; zoomOutPx: number }[];
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
