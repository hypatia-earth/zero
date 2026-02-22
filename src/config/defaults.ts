/**
 * Default configuration for Hypatia Zero
 *
 * Layer declarations live in src/layers/{layer}/index.ts.
 * LayerService is the authority for layer config.
 */

import { ALL_LAYERS, BUILT_IN_LAYERS, type ZeroConfig, type TLayer, type TBuiltInLayer } from './types';
import { CAMERA_DEFAULTS } from '../aurora/defaults';

export const EARTH_RADIUS = 6371000; // meters

/** Built-in layer IDs only (for OptionsService iteration) */
export const builtInLayerIds: readonly TBuiltInLayer[] = BUILT_IN_LAYERS;

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

  beacon: false,
  beaconUrl: '/api/beacon',

  bootstrap: {
    progressSleep: 100,
  },

  camera: {
    ...CAMERA_DEFAULTS,
    minDistance: 1.047,
    maxDistance: 6.65,
    defaultDistance: 3.2,
  },

  defaultLayers: ['earth', 'sun', 'temp'],

  // revisit these, ASAP
  render: {
    opacityAnimationMs: 100,
    logoEnabled: true,
  },

  cameraUI: {
    rectDefaultSize: 480,
    rectMinWidth: 320,
    rectMinHeight: 240,
    fps: 15,
    durations: [1, 3, 5, 10] as const,
    borderColorIdle: '#44cc66',
    borderColorRecording: '#cc4444',
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
