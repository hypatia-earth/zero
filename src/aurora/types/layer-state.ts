/**
 * LayerState — data interpolation state aurora layers need each frame.
 *
 * Built by the host worker from per-layer slot state and current view time;
 * consumed by aurora layers (currently wind) to drive interpolation between
 * two timestep buffers.
 *
 * Lives in aurora/types/ for autarky; the host re-exports from `config/types`
 * for any host-side use.
 */

export type TLayerMode = 'loading' | 'single' | 'pair';

export interface LayerState {
  mode: TLayerMode;
  lerp: number;      // 0-1 interpolation factor (only valid in 'pair' mode)
  time: Date;        // current view time
}
