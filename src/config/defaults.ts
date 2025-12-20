/**
 * Default configuration for Hypatia Zero
 */

import { ALL_LAYERS, type ZeroConfig, type TLayer } from './types';

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
    timeslotsPerLayer: 4,     // 2 interpolation + 2 prefetch
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
    { id: 'earth', label: 'Earth', buttonLabel: 'Earth', category: 'base', defaultEnabled: true },
    { id: 'sun', label: 'Sun', buttonLabel: 'Sun', category: 'overlay', defaultEnabled: true },
    { id: 'grid', label: 'Grid', buttonLabel: 'Grid', category: 'overlay', defaultEnabled: false },
    {
      id: 'temp', label: 'Temperature', buttonLabel: 'Temp', category: 'weather', defaultEnabled: true,
      params: ['temperature_2m'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'rain', label: 'Precipitation', buttonLabel: 'Rain', category: 'weather', defaultEnabled: false,
      params: ['precipitation', 'rain', 'total_precipitation'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'clouds', label: 'Cloud Cover', buttonLabel: 'Clouds', category: 'weather', defaultEnabled: false,
      params: ['cloud_cover', 'total_cloud_cover'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'humidity', label: 'Humidity', buttonLabel: 'Humidity', category: 'weather', defaultEnabled: false,
      params: ['relative_humidity_2m'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'wind', label: 'Wind', buttonLabel: 'Wind', category: 'weather', defaultEnabled: false,
      params: ['wind_u_component_200m', 'wind_v_component_200m'],
      defaultSizeEstimate: 16_000_000,
      slabs: [{ name: 'u', sizeMB: 26 }, { name: 'v', sizeMB: 26 }],
    },
    {
      id: 'pressure', label: 'Pressure', buttonLabel: 'Pressure', category: 'weather', defaultEnabled: false,
      params: ['pressure_msl', 'mean_sea_level_pressure'],
      defaultSizeEstimate: 2_000_000,
      slabs: [{ name: 'raw', sizeMB: 26 }, { name: 'grid', sizeMB: 1 }],
    },
  ],

  defaultLayers: ['earth', 'sun', 'temp'],

  readyLayers: ['earth', 'sun', 'grid', 'temp', 'pressure', 'wind'],

  sun: {
    coreRadius: 0.015,
    glowRadius: 0.12,
    coreColor: [1.0, 0.7, 0.3],
    glowColor: [1.0, 0.6, 0.2],
  },

  grid: {
    opacity: 0.8,
    labelMaxRadiusPx: 500,
    lodLevels: [
      { lonSpacing: 90, latSpacing: 90 },   // LoD 0: 4 lon, 3 lat
      { lonSpacing: 60, latSpacing: 30 },   // LoD 1: 6 lon, 7 lat
      { lonSpacing: 45, latSpacing: 30 },   // LoD 2: 8 lon, 7 lat
      { lonSpacing: 30, latSpacing: 30 },   // LoD 3: 12 lon, 7 lat
      { lonSpacing: 20, latSpacing: 20 },   // LoD 4: 18 lon, 9 lat
      { lonSpacing: 15, latSpacing: 15 },   // LoD 5: 24 lon, 13 lat
      { lonSpacing: 10, latSpacing: 10 },   // LoD 6: 36 lon, 19 lat
      { lonSpacing: 5, latSpacing: 5 },     // LoD 7: 72 lon, 37 lat
    ],
  },

  render: {
    opacityAnimationMs: 100,  // Layer fade in/out duration
  },
};
