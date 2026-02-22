/**
 * Configuration types for Hypatia Zero
 */

import type { Signal } from '@preact/signals-core';
import type { TModelParam } from './models';

// ─────────────────────────────────────────────────────────────────────────────
// Layer definitions
// ─────────────────────────────────────────────────────────────────────────────

export const BUILT_IN_LAYERS = ['earth', 'sun', 'graticule', 'temp', 'rain', 'clouds', 'humidity', 'pressure', 'wind'] as const;
export type TBuiltInLayer = typeof BUILT_IN_LAYERS[number];

export const CUSTOM_LAYERS = ['custom0', 'custom1', 'custom2', 'custom3', 'custom4', 'custom5', 'custom6', 'custom7'] as const;
export type TCustomLayer = typeof CUSTOM_LAYERS[number];

export const ALL_LAYERS = [...BUILT_IN_LAYERS, ...CUSTOM_LAYERS, '_preview'] as const;
export type TLayer = TBuiltInLayer | TCustomLayer | '_preview';

/** Layer categories */
export const LAYER_CATEGORIES = ['celestial', 'weather', 'reference', 'custom'] as const;
export type TLayerCategory = typeof LAYER_CATEGORIES[number];
export const LAYER_CATEGORY_LABELS: Record<TLayerCategory, string> = {
  celestial: 'Celestial',
  weather: 'Weather',
  reference: 'Reference',
  custom: 'Custom',
};


/** Branded timestep string, format: "YYYY-MM-DDTHHMM" (e.g., "2025-12-13T0600") */
export type TTimestep = string & { readonly __brand: 'timestep' };

/** Timestep with metadata from discovery */
export interface Timestep {
  index: number;
  timestep: TTimestep;
  run: string;
  url: string;
  /** T+0 of its model run — backward sum params (e.g. precipitation) are undefined here */
  isAnalysis: boolean;
  /** For analysis timesteps: URL to previous run's file where this time is T+6 (backward sums defined) */
  fallbackUrl?: string;
}

/** Layer data state for interpolation */
export type TLayerMode = 'loading' | 'single' | 'pair';

export interface LayerState {
  mode: TLayerMode;
  lerp: number;      // 0-1 interpolation factor (only valid in 'pair' mode)
  time: Date;        // current view time
}

/** Task for QueueService to execute */
export interface QueueTask {
  url: string;
  param: TLayer;               // layer ID (built-in or custom)
  timestep: TTimestep;
  sizeEstimate: number;
  modelParam: TModelParam;
  slabIndex: number;
  isFast: boolean;
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
  readonly queueStats: Signal<QueueStats>;
  submitFileOrders(
    orders: FileOrder[],
    onComplete?: (index: number, buffer: ArrayBuffer) => void | Promise<void>
  ): Promise<void>;
  dispose(): void;
}

/** Timestep download order for QueueService */
export interface TimestepOrder {
  url: string;
  param: TLayer;               // layer ID (built-in or custom)
  timestep: TTimestep;
  sizeEstimate: number;  // Estimated bytes (NaN = use default)
  slabIndex: number;     // Which slab to upload to (0 for single-slab layers)
  modelParam: TModelParam;
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

export interface ParamLink {
  param: string;  // Display name (e.g., "U component", "V component")
  url: string;    // URL to ECMWF parameter database
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

  /** Send beacon request after bootstrap (success/error) */
  beacon: boolean;

  /** Beacon endpoint URL (default: /api/beacon) */
  beaconUrl: string;

  /** Bootstrap progress settings */
  bootstrap: BootstrapConfig;

  /** Camera settings */
  camera: {
    fov: number;           // Field of view in degrees
    near: number;          // Near clipping plane
    far: number;           // Far clipping plane
    minDistance: number;   // Closest zoom (Earth radii from center)
    maxDistance: number;   // Furthest zoom
    defaultDistance: number;
  };

  /** Default active layers */
  defaultLayers: TLayer[];

  /** Render settings */
  render: {
    opacityAnimationMs: number;  // Layer fade in/out duration
    logoEnabled: boolean;        // Show logo when all layers off
  };

  /** Pressure color presets */
  pressureColors: {
    white: readonly [number, number, number, number];
    violet: readonly [number, number, number, number];
    gold: readonly [number, number, number, number];
    teal: readonly [number, number, number, number];
    gradient: {
      low: readonly [number, number, number, number];
      ref: readonly [number, number, number, number];
      high: readonly [number, number, number, number];
    };
    normalOther: readonly [number, number, number, number];
  };

  /** Camera capture UI settings (distinct from 3D camera above) */
  cameraUI: CameraConfig;
}

export interface CameraConfig {
  rectDefaultSize: number;
  rectMinWidth: number;
  rectMinHeight: number;
  fps: number;
  durations: readonly number[];
  borderColorIdle: string;
  borderColorRecording: string;
}
