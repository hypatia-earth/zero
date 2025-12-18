/**
 * Default configuration for Hypatia Zero
 */

import type { ZeroConfig, LayerId } from './types';

export const EARTH_RADIUS = 6371000; // meters

/** All layer IDs in render order */
export const layerIds: LayerId[] = ['earth', 'sun', 'grid', 'temp', 'rain', 'clouds', 'humidity', 'wind', 'pressure'];

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
    slotSizeMB: 27,        // ~26.4 MB per slot (O1280 gaussian grid)
  },

  camera: {
    fov: 75,              // Field of view in degrees
    near: 0.1,            // Near clipping plane
    far: 100,             // Far clipping plane
    minDistance: 1.047,   // ~300 km from surface (Earth radii)
    maxDistance: 6.65,    // ~36,000 km from surface (geostationary)
    defaultDistance: 3.2, // ~14,000 km from surface
  },

  layers: [
    { id: 'earth', label: 'Earth', category: 'base', defaultEnabled: true },
    { id: 'sun', label: 'Sun', category: 'overlay', defaultEnabled: true },
    { id: 'grid', label: 'Grid', category: 'overlay', defaultEnabled: false },
    {
      id: 'temp', label: 'Temperature', category: 'weather', defaultEnabled: true,
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'rain', label: 'Precipitation', category: 'weather', defaultEnabled: false,
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'clouds', label: 'Clouds', category: 'weather', defaultEnabled: false,
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'humidity', label: 'Humidity', category: 'weather', defaultEnabled: false,
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'wind', label: 'Wind', category: 'weather', defaultEnabled: false,
      defaultSizeEstimate: 16_000_000,
      slabs: [{ name: 'u', sizeMB: 26 }, { name: 'v', sizeMB: 26 }],
    },
    {
      id: 'pressure', label: 'Pressure', category: 'weather', defaultEnabled: false,
      defaultSizeEstimate: 2_000_000,
      slabs: [{ name: 'raw', sizeMB: 26 }, { name: 'grid', sizeMB: 1 }],
    },
  ],

  defaultLayers: ['earth', 'sun', 'temp'],

  sun: {
    coreRadius: 0.015,
    glowRadius: 0.12,
    coreColor: [1.0, 0.7, 0.3],
    glowColor: [1.0, 0.6, 0.2],
  },

  render: {
    opacityAnimationMs: 100,  // Layer fade in/out duration
  },
};
