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
      params: ['wind_speed_10m', 'u_component_of_wind', 'v_component_of_wind'],
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

  readyLayers: ['earth', 'sun', 'grid', 'temp', 'pressure'],

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
