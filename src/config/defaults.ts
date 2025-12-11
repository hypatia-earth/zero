/**
 * Default configuration for Hypatia Zero
 */

import type { ZeroConfig } from './types';

export const EARTH_RADIUS = 6371000; // meters

export const defaultConfig: ZeroConfig = {
  dataBaseUrl: 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs',
  dataWindowDays: 5,
  prefetchCount: 24,
  gpuBudgetMB: 800,

  camera: {
    fov: 75,              // Field of view in degrees
    near: 0.1,            // Near clipping plane
    far: 100,             // Far clipping plane
    minDistance: 1.05,    // Just above surface (Earth radii)
    maxDistance: 5.0,     // Far view
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

  sun: {
    coreRadius: 0.015,
    glowRadius: 0.12,
    coreColor: [1.0, 0.7, 0.3],
    glowColor: [1.0, 0.6, 0.2],
  },
};
