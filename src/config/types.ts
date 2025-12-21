/**
 * Configuration types for Hypatia Zero
 *
 * Layer hierarchy:
 *   TLayer (all layers, have button in Layer panel)
 *   ├── TDecorationLayer (earth, sun, grid)
 *   └── TWeatherLayer (need store, request data from ECMWF)
 *       ├── TWeatherTextureLayer (simple: temp, rain, clouds, humidity)
 *       └── TWeatherGeometryLayer (complex: pressure, wind)
 */

import type { Signal } from '@preact/signals-core';

// ─────────────────────────────────────────────────────────────────────────────
// Layer definitions (arrays as const, types derived)
// ─────────────────────────────────────────────────────────────────────────────

/** Decoration layers (no weather data) */
export const DECORATION_LAYERS = ['earth', 'sun', 'grid'] as const;
export type TDecorationLayer = typeof DECORATION_LAYERS[number];

/** Weather texture layers (buffer rebind + interpolation) */
export const WEATHER_TEXTURE_LAYERS = ['temp', 'rain', 'clouds', 'humidity'] as const;
export type TWeatherTextureLayer = typeof WEATHER_TEXTURE_LAYERS[number];

/** Weather geometry layers (compute shader pipeline) */
export const WEATHER_GEOMETRY_LAYERS = ['pressure', 'wind'] as const;
export type TWeatherGeometryLayer = typeof WEATHER_GEOMETRY_LAYERS[number];

/** All weather layers */
export const WEATHER_LAYERS = [...WEATHER_TEXTURE_LAYERS, ...WEATHER_GEOMETRY_LAYERS] as const;
export type TWeatherLayer = TWeatherTextureLayer | TWeatherGeometryLayer;

/** All layers */
export const ALL_LAYERS = [...DECORATION_LAYERS, ...WEATHER_LAYERS] as const;
export type TLayer = TDecorationLayer | TWeatherLayer;

/** Layer categories */
export const LAYER_CATEGORIES = ['base', 'weather', 'overlay'] as const;
export type TLayerCategory = typeof LAYER_CATEGORIES[number];
export const LAYER_CATEGORY_LABELS: Record<TLayerCategory, string> = {
  base: 'Base',
  weather: 'Weather',
  overlay: 'Overlays',
};

/** ECMWF data parameters */
export const ECMWF_PARAMS = [
  'temperature_2m',
  'precipitation', 'rain', 'total_precipitation',
  'cloud_cover', 'total_cloud_cover',
  'relative_humidity_2m',
  'wind_u_component_10m', 'wind_v_component_10m',
  'pressure_msl', 'mean_sea_level_pressure',
] as const;
export type TParam = typeof ECMWF_PARAMS[number];

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

/** Type guard: is this a weather layer? */
export const isWeatherLayer = (id: string): id is TWeatherLayer =>
  (WEATHER_LAYERS as readonly string[]).includes(id);

/** Type guard: is this a weather texture layer? */
export const isWeatherTextureLayer = (layer: TWeatherLayer): layer is TWeatherTextureLayer =>
  (WEATHER_TEXTURE_LAYERS as readonly string[]).includes(layer);

// ─────────────────────────────────────────────────────────────────────────────
// Runtime layer subsets
// ─────────────────────────────────────────────────────────────────────────────

/** Weather layers cached by Service Worker */
export const SW_CACHED_WEATHER_LAYERS: TWeatherLayer[] = [...WEATHER_LAYERS];

export type TModel = 'ecmwf_ifs' | 'ecmwf_ifs025';

/** Branded timestep string, format: "YYYY-MM-DDTHHMM" (e.g., "2025-12-13T0600") */
export type TTimestep = string & { readonly __brand: 'timestep' };

/** Timestep with metadata from discovery */
export interface Timestep {
  index: number;
  timestep: TTimestep;
  run: string;
  url: string;
}

/** Layer data state for interpolation */
export type TLayerMode = 'loading' | 'single' | 'pair';

export interface LayerState {
  mode: TLayerMode;
  lerp: number;      // 0-1 interpolation factor (only valid in 'pair' mode)
  time: Date;        // current view time
}

/** File download order for QueueService */
export interface FileOrder {
  url: string;
  size: number;
}

/** Queue statistics for UI */
export interface QueueStats {
  bytesQueued: number;
  bytesCompleted: number;
  bytesPerSec: number | undefined;
  etaSeconds: number | undefined;
  status: 'idle' | 'downloading';
}

/** QueueService public API */
export interface IQueueService {
  readonly stats: Signal<QueueStats>;
  submitFileOrders(
    orders: FileOrder[],
    onComplete?: (index: number, buffer: ArrayBuffer) => void | Promise<void>
  ): Promise<void>;
  dispose(): void;
}

/** Timestep download order for QueueService */
export interface TimestepOrder {
  url: string;
  param: TWeatherLayer;
  timestep: TTimestep;
  sizeEstimate: number;  // Estimated bytes (NaN = use default)
  slabIndex: number;     // Which slab to upload to (0 for single-slab layers)
  omParam: string;       // Open-Meteo parameter name to fetch
}

/** OmService preflight result */
export interface OmPreflight {
  totalBytes: number;
  chunks: number;
}

/** OmService slice callback data */
export interface OmSlice {
  data: Float32Array;
  sliceIndex: number;
  totalSlices: number;
  done: boolean;
}

/** OmService public API */
export interface IOmService {
  /** Stream fetch with preflight callback for exact size, then slice callbacks */
  fetch(
    url: string,
    param: string,
    onPreflight: (info: OmPreflight) => void,
    onSlice: (slice: OmSlice) => void
  ): Promise<Float32Array>;
}

/** GPU buffer slab definition for weather layers */
export interface SlabConfig {
  name: string;   // e.g., 'data', 'u', 'v', 'raw', 'grid'
  sizeMB: number; // Size in megabytes
}

export interface LayerConfig {
  id: TLayer;
  label: string;              // Full name (e.g., "Temperature")
  buttonLabel: string;        // Short name for UI buttons (e.g., "Temp")
  category: TLayerCategory;
  params?: TParam[];             // ECMWF param names (weather layers)
  defaultSizeEstimate?: number;  // bytes per timestep (weather layers)
  slabs?: SlabConfig[];          // GPU buffer slabs (weather layers only)
}

export interface DiscoveryConfig {
  /** S3 bucket root URL for data_spatial */
  root: string;
  /** Models to discover */
  models: TModel[];
  /** Default model to use */
  default: TModel;
}

export interface SunConfig {
  /** Core disc radius in NDC units */
  coreRadius: number;
  /** Glow radius in NDC units */
  glowRadius: number;
  /** Core color RGB (0-1) */
  coreColor: [number, number, number];
  /** Glow color RGB (0-1) */
  glowColor: [number, number, number];
}

export interface GridLodLevel {
  lonSpacing: number;  // degrees between longitude lines
  latSpacing: number;  // degrees between latitude lines
}

export interface GridConfig {
  /** Default opacity 0-1 */
  opacity: number;
  /** Max globe radius in CSS pixels before label font starts shrinking */
  labelMaxRadiusPx: number;
  /** LoD levels indexed by level number */
  lodLevels: GridLodLevel[];
}

export interface WindConfig {
  /** Default opacity 0-1 */
  opacity: number;
  /** Animation speed in updates/sec (1 update = 1 segment forward) */
  animSpeed: number;
  /** Fraction of line visible (0-1) */
  snakeLength: number;
  /** Screen-space line width factor */
  lineWidth: number;
  /** Trace steps per wind line */
  segmentsPerLine: number;
  /** Wind speed to arc distance scale */
  stepFactor: number;
  /** Default line count */
  seedCount: 8192 | 16384 | 32768 | 49152 | 65536;
}

export interface AppConfig {
  /** Application name */
  name: string;
  /** Build version from package.json */
  version: string;
  /** Git commit hash */
  hash: string;
  /** Build timestamp */
  timestamp: string;
  /** Environment: development | production */
  environment: string;
}

export interface BootstrapConfig {
  /** Delay in ms after progress update to allow UI redraw */
  progressSleep: number;
}

export interface ZeroConfig {
  /** App metadata (injected at build) */
  app: AppConfig;

  /** Bootstrap progress settings */
  bootstrap: BootstrapConfig;

  /** Discovery configuration */
  discovery: DiscoveryConfig;

  /** Open-Meteo S3 base URL - DEPRECATED: use discovery.root */
  dataBaseUrl: string;

  /** GPU configuration */
  gpu: {
    timeslotsPerLayer: number;   // Default timeslots per layer (4)
  };

  /** Camera settings */
  camera: {
    fov: number;           // Field of view in degrees
    near: number;          // Near clipping plane
    far: number;           // Far clipping plane
    minDistance: number;   // Closest zoom (Earth radii from center)
    maxDistance: number;   // Furthest zoom
    defaultDistance: number;
  };

  /** Layer definitions */
  layers: LayerConfig[];

  /** Default active layers */
  defaultLayers: TLayer[];

  /** Ready layers (fully implemented, shown in UI) */
  readyLayers: TLayer[];

  /** Sun rendering settings */
  sun: SunConfig;

  /** Grid layer settings */
  grid: GridConfig;

  /** Wind layer settings */
  wind: WindConfig;

  /** Render settings */
  render: {
    opacityAnimationMs: number;  // Layer fade in/out duration
    logoEnabled: boolean;        // Show logo when all layers off
  };
}
