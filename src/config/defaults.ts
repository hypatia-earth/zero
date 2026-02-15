/**
 * Default configuration for Hypatia Zero
 *
 * Layer declarations live in src/layers/{layer}/index.ts.
 * LayerService is the authority for layer config.
 */

import { ALL_LAYERS, type ZeroConfig, type TLayer } from './types';
import { CAMERA_DEFAULTS } from '../aurora/defaults';

export const EARTH_RADIUS = 6371000; // meters

/** All layer IDs in render order */
export const layerIds: readonly TLayer[] = ALL_LAYERS;

export const defaultConfig: ZeroConfig = {
  app: {
    name: 'Hypatia Zero',
    version: '0.0.0',
    hash: 'dev',
    timestamp: '',
    environment: 'development',
  },

  bootstrap: {
    progressSleep: 100,
  },

  discovery: {
    root: 'https://openmeteo.s3.amazonaws.com/data_spatial/',
    models: ['ecmwf_ifs'],
    default: 'ecmwf_ifs',
  },

  dataBaseUrl: 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs',

  gpu: {
    timeslotsPerLayer: 4,
  },

  camera: {
    ...CAMERA_DEFAULTS,
    minDistance: 1.047,
    maxDistance: 6.65,
    defaultDistance: 3.2,
  },

  // Layer config now in src/layers/*/index.ts, read via LayerService

  defaultLayers: ['earth', 'sun', 'temp'],
  readyLayers: ['earth', 'sun', 'graticule', 'temp', 'pressure', 'wind'],

  sun: {
    coreRadius: 0.015,
    glowRadius: 0.12,
    coreColor: [1.0, 0.7, 0.3],
    glowColor: [1.0, 0.6, 0.2],
  },

  graticule: {
    opacity: 0.8,
    labelMaxRadiusPx: 500,
    lodLevels: [
      { spacing: 30, zoomInPx: 0, zoomOutPx: 0 },
      { spacing: 20, zoomInPx: 200, zoomOutPx: 170 },
      { spacing: 15, zoomInPx: 350, zoomOutPx: 300 },
      { spacing: 10, zoomInPx: 500, zoomOutPx: 450 },
      { spacing: 5, zoomInPx: 650, zoomOutPx: 600 },
    ],
  },

  wind: {
    opacity: 0.8,
    animSpeed: 30,
    snakeLength: 0.25,
    lineWidth: 0.002,
    segmentsPerLine: 32,
    stepFactor: 0.005,
    seedCount: 8192,
    radius: 1.0,
  },

  render: {
    opacityAnimationMs: 100,
    logoEnabled: true,
  },

  pressureColors: {
    white:  [1, 1, 1, 0.85] as const,
    violet: [0.72, 0.50, 0.88, 0.85] as const,
    gold:   [0.80, 0.62, 0.32, 0.85] as const,
    teal:   [0.32, 0.72, 0.62, 0.85] as const,
    gradient: {
      low:  [0.28, 0.58, 1, 1] as const,
      ref:  [1, 1, 1, 1] as const,
      high: [1, 0.50, 0.35, 1] as const,
    },
    normalOther: [1, 1, 1, 0.5] as const,
  },
};
