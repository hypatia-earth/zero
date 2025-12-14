/**
 * Configuration types for Hypatia Zero
 */

import type { Signal } from '@preact/signals-core';

export type LayerId = 'earth' | 'sun' | 'grid' | 'temp' | 'rain';

export type TModel = 'ecmwf_ifs' | 'ecmwf_ifs025';

/** Weather parameter identifier */
export type TParam = 'temp' | 'rain' | 'wind' | 'pressure';

/** Branded timestep string, format: "YYYY-MM-DDTHHMM" (e.g., "2025-12-13T0600") */
export type TTimestep = string & { readonly __brand: 'timestep' };

/** Timestep with metadata from discovery */
export interface Timestep {
  index: number;
  timestep: TTimestep;
  run: string;
  url: string;
}

/** DiscoveryService public API */
export interface IDiscoveryService {
  // Lifecycle
  explore(): Promise<void>;

  // Conversion
  toDate(ts: TTimestep): Date;
  toTimestep(date: Date): TTimestep;
  toKey(ts: TTimestep): string;

  // Navigation (from discovered list)
  next(ts: TTimestep, model?: TModel): TTimestep | null;
  prev(ts: TTimestep, model?: TModel): TTimestep | null;
  adjacent(time: Date, model?: TModel): [TTimestep, TTimestep];

  // Data access
  url(ts: TTimestep, model?: TModel): string;
  first(model?: TModel): TTimestep;
  last(model?: TModel): TTimestep;
  index(ts: TTimestep, model?: TModel): number;
  contains(ts: TTimestep, model?: TModel): boolean;

  // Collections
  variables(model?: TModel): string[];
  timesteps(model?: TModel): Timestep[];
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
    onProgress?: (index: number, total: number) => void | Promise<void>
  ): Promise<ArrayBuffer[]>;
  dispose(): void;
}

/** Timestep download order for QueueService */
export interface TimestepOrder {
  url: string;
  param: TParam;
  timestep: TTimestep;
  sizeEstimate: number;  // Estimated bytes (NaN = use default)
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

export interface LayerConfig {
  id: LayerId;
  label: string;
  category: 'base' | 'weather' | 'overlay';
  defaultEnabled: boolean;
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

  /** Data window in days (±days from today) */
  dataWindowDays: number;

  /** Number of timesteps to prefetch */
  prefetchCount: number;

  /** GPU memory budget for timestep data (MB) */
  gpuBudgetMB: number;

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
  defaultLayers: LayerId[];

  /** Sun rendering settings */
  sun: SunConfig;
}
