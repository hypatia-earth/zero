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
    {
      id: 'earth', label: 'Earth', buttonLabel: 'Earth', category: 'celestial',
      description: 'Satellite imagery basemap from Natural Earth.',
    },
    {
      id: 'sun', label: 'Sun', buttonLabel: 'Sun', category: 'celestial',
      description: 'Real-time sun position with atmosphere scattering.',
    },
    {
      id: 'grid', label: 'Grid', buttonLabel: 'Grid', category: 'reference',
      description: 'Latitude/longitude graticule with degree labels.',
    },
    {
      id: 'temp', label: 'Temperature', buttonLabel: 'Temperature', category: 'weather',
      description: 'Air temperature at 2 meters above ground.',
      links: [{ param: '2t', url: 'https://codes.ecmwf.int/grib/param-db/?id=167' }],
      params: ['temperature_2m'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'rain', label: 'Precipitation', buttonLabel: 'Rain', category: 'weather',
      description: 'Total precipitation rate (rain, snow, hail).',
      links: [{ param: 'tp', url: 'https://codes.ecmwf.int/grib/param-db/?id=228' }],
      params: ['precipitation'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'clouds', label: 'Cloud Cover', buttonLabel: 'Clouds', category: 'weather',
      description: 'Total cloud cover as fraction of sky.',
      links: [{ param: 'tcc', url: 'https://codes.ecmwf.int/grib/param-db/?id=164' }],
      params: ['cloud_cover'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'humidity', label: 'Humidity', buttonLabel: 'Humidity', category: 'weather',
      description: 'Relative humidity at 2 meters above ground.',
      links: [{ param: 'r', url: 'https://codes.ecmwf.int/grib/param-db/?id=157' }],
      params: ['relative_humidity_2m'],
      defaultSizeEstimate: 8_000_000,
      slabs: [{ name: 'data', sizeMB: 26 }],
    },
    {
      id: 'wind', label: 'Wind', buttonLabel: 'Wind', category: 'weather',
      description: 'Wind speed and direction at 10 meters above ground.',
      links: [
        { param: '10u', url: 'https://codes.ecmwf.int/grib/param-db/?id=165' },
        { param: '10v', url: 'https://codes.ecmwf.int/grib/param-db/?id=166' },
      ],
      params: ['wind_u_component_10m', 'wind_v_component_10m'],
      defaultSizeEstimate: 8_200_000,
      slabs: [{ name: 'u', sizeMB: 26 }, { name: 'v', sizeMB: 26 }],
    },
    {
      id: 'pressure', label: 'Pressure', buttonLabel: 'Pressure', category: 'weather',
      description: 'Atmospheric pressure reduced to mean sea level.',
      links: [{ param: 'msl', url: 'https://codes.ecmwf.int/grib/param-db/?id=151' }],
      params: ['pressure_msl'],
      defaultSizeEstimate: 2_000_000,
      slabs: [{ name: 'raw', sizeMB: 26 }, { name: 'grid', sizeMB: 1 }],
      useSynthData: false,
    },
  ],

  // layers auto-enabled, when url is '/'
  defaultLayers: ['earth', 'sun', 'temp'],

  // layers marked as ready to use.
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
      // zoomInPx/zoomOutPx: globe radius in screen pixels for LoD transitions
      { spacing: 30, zoomInPx: 0, zoomOutPx: 0 },       // LoD 0
      { spacing: 20, zoomInPx: 200, zoomOutPx: 170 },   // LoD 1
      { spacing: 15, zoomInPx: 350, zoomOutPx: 300 },   // LoD 2
      { spacing: 10, zoomInPx: 500, zoomOutPx: 450 },   // LoD 3
      { spacing: 5, zoomInPx: 650, zoomOutPx: 600 },    // LoD 4
    ],
  },

  wind: {
    opacity: 0.8,
    animSpeed: 30,        // updates per second (1 update = 1 segment forward)
    snakeLength: 0.25,    // fraction of line visible (0-1)
    lineWidth: 0.002,     // screen-space width factor
    segmentsPerLine: 32,  // trace steps per wind line
    stepFactor: 0.005,    // wind speed to arc distance scale
    seedCount: 8192,      // default line count
  },

  render: {
    opacityAnimationMs: 100,  // Layer fade in/out duration
    logoEnabled: true,        // Show logo when all layers off
  },

  // ============================================================
  // Pressure Color Presets
  // ============================================================
  pressureColors: {
    // 4 colors for solid and normal modes (oklch L=0.70, C=0.18 matching layer color)
    white:  [1, 1, 1, 0.85] as const,
    violet: [0.72, 0.50, 0.88, 0.85] as const,  // hue 300° (layer color)
    gold:   [0.80, 0.62, 0.32, 0.85] as const,  // hue 70°
    teal:   [0.32, 0.72, 0.62, 0.85] as const,  // hue 170°

    // Fixed gradient colors (oklch mirrored: L=0.70, C=0.18)
    gradient: {
      low:  [0.28, 0.58, 1, 1] as const,   // oklch(0.70, 0.18, 260°) blue
      ref:  [1, 1, 1, 1] as const,         // white at 1012
      high: [1, 0.50, 0.35, 1] as const,   // oklch(0.70, 0.18, 30°) red
    },

    // "Other" color for normal mode (dimmed white)
    normalOther: [1, 1, 1, 0.5] as const,
  },
};
