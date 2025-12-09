/**
 * Default configuration for Hypatia Zero
 */

import type { ZeroConfig } from './types';

export const EARTH_RADIUS = 6371000; // meters

export const defaultConfig: ZeroConfig = {
  dataBaseUrl: 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs',
  dataWindowDays: 5,
  prefetchCount: 24,

  camera: {
    minDistance: 1.05,  // Just above surface
    maxDistance: 5.0,   // Far view
    defaultDistance: 3.0,
  },

  layers: [
    { id: 'earth', label: 'Earth', category: 'base', defaultEnabled: true },
    { id: 'sun', label: 'Sun', category: 'overlay', defaultEnabled: true },
    { id: 'grid', label: 'Grid', category: 'overlay', defaultEnabled: false },
    { id: 'temp', label: 'Temperature', category: 'weather', defaultEnabled: true },
    { id: 'rain', label: 'Precipitation', category: 'weather', defaultEnabled: false },
  ],

  defaultLayers: ['earth', 'sun', 'temp'],
};
