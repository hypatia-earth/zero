/**
 * Aurora public type surface — barrel re-exports.
 *
 * Initial location: `src/aurora/types/`. Move to `repos/shared/types/` as
 * `@hypatia/types` once both Sub-A and Sub-B grep gates pass; the import
 * path change will be the only delta.
 */

export type { AuroraLayer, AuroraLayerContext, AuroraLayerFrame, AuroraDataEvent } from './aurora-layer';
export type { TLayerMode, LayerState } from './layer-state';
export type { TTimestep } from './timestep';
export type { SlabConfig } from './slab-config';

export type {
  EngineOpts,
  WindOpts,
  PressureOpts,
  GraticuleOpts,
  CitiesOpts,
  ScalarFieldOpts,
  LayerEntry,
  LayersOpts,
  AuroraOptions,
} from './options';
export type { AuroraConfig } from './config';

export type { Palette, PaletteStop, PaletteRuntimeId } from './palette';
export type { ModelSpec } from './model-spec';
export type { AssetSpec, AssetBag } from './asset';

export type { AuroraEvent } from './events';
export type { AuroraStats, AuroraMemoryStats } from './stats';
export type { PickResult } from './picking';
