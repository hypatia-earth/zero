/**
 * Options Schema - Single source of truth for user-configurable options
 *
 * Uses Zod for validation + UI metadata for form generation.
 * Filter field determines which entry points show each option.
 */

import { z } from 'zod';
import type { TLayer } from '../config/types';
import { defaultConfig } from '../config/defaults';

// ============================================================
// UI Metadata Types
// ============================================================

type ControlType = 'toggle' | 'slider' | 'select' | 'radio' | 'pressure-colors' | 'layer-toggle';

/** Impact level for option changes */
type OptionImpact = 'uniform' | 'recreate';

/** Persistence mode: 'url' for shareable view state, 'local' for user preferences */
type PersistMode = 'url' | 'local';

/** Filter determines which dialog entry points show this option */
type OptionFilter = TLayer | 'global' | 'dataCache' | 'gpu' | 'queue';

interface UIMetadata {
  label: string;
  description?: string;
  group: 'interface' | 'regional' | 'download' | 'environmental' | 'interaction' | 'layers' | 'gpu' | 'advanced' | 'performance';
  filter: OptionFilter | OptionFilter[];
  order: number;
  control: ControlType;
  persist?: PersistMode;  // default: 'local'
  advanced?: boolean;
  hidden?: boolean;       // Hide from options dialog (for internal use)
  model?: 'inertia' | 'velocity';
  device?: 'mouse' | 'touch';
  impact?: OptionImpact;
}

interface SliderMeta extends UIMetadata {
  control: 'slider';
  min: number;
  max: number;
  step: number;
}

interface SelectMeta extends UIMetadata {
  control: 'select';
  options: { value: string | number; label: string; localhostOnly?: boolean; maxCores?: number }[];
}

interface ToggleMeta extends UIMetadata {
  control: 'toggle';
}

interface RadioMeta extends UIMetadata {
  control: 'radio';
  options: { value: string | number; label: string; localhostOnly?: boolean }[];
}

interface PressureColorsMeta extends UIMetadata {
  control: 'pressure-colors';
}

interface LayerToggleMeta extends UIMetadata {
  control: 'layer-toggle';
  layerId: string;  // For CSS color variable lookup
}

type OptionMeta = SliderMeta | SelectMeta | ToggleMeta | RadioMeta | PressureColorsMeta | LayerToggleMeta;

/** Helper to attach metadata to Zod schema */
function opt<T extends z.ZodTypeAny>(schema: T, meta: OptionMeta): T & { _meta: OptionMeta } {
  return Object.assign(schema, { _meta: meta });
}

// ============================================================
// Group Definitions
// ============================================================

export const optionGroups = {
  interface: {
    id: 'interface',
    label: 'Interface',
    description: 'User interface behavior',
    order: 0,
  },
  environmental: {
    id: 'environmental',
    label: 'Environmental',
    description: 'Power and resource usage',
    order: 1,
  },
  performance: {
    id: 'performance',
    label: 'Performance',
    description: 'Loading strategy and GPU memory',
    order: 2,
  },
  download: {
    id: 'download',
    label: 'Download',
    description: 'Data loading and caching',
    order: 3,
  },
  interaction: {
    id: 'interaction',
    label: 'Interaction',
    description: 'Controls and input settings',
    order: 4,
  },
  layers: {
    id: 'layers',
    label: 'Layers',
    description: 'Visual appearance of map layers',
    order: 5,
  },
  regional: {
    id: 'regional',
    label: 'Regional',
    description: 'Location and unit preferences',
    order: 6,
  },
  gpu: {
    id: 'gpu',
    label: 'GPU',
    description: 'Graphics memory and performance',
    order: 7,
  },
  advanced: {
    id: 'advanced',
    label: 'Advanced',
    description: 'Fine-tuning and experimental options',
    order: 99,
  },
} as const;

// ============================================================
// Pressure Color Option Schema
// ============================================================

const Color = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const PressureColorOptionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('solid'),
    colors: z.tuple([Color]),           // [all]
  }),
  z.object({
    mode: z.literal('gradient'),
    colors: z.tuple([Color, Color, Color]),  // [low, ref, high]
  }),
  z.object({
    mode: z.literal('normal'),
    colors: z.tuple([Color, Color]),    // [ref, other]
  }),
  z.object({
    mode: z.literal('debug'),
  }),
]);

export type PressureColorOption = z.infer<typeof PressureColorOptionSchema>;

export const PRESSURE_COLOR_DEFAULT: PressureColorOption = {
  mode: 'solid',
  colors: [[1, 1, 1, 0.85]],
};

// ============================================================
// Options Schema
// ============================================================

export const optionsSchema = z.object({
  _version: z.number().default(1),

  // ----------------------------------------------------------
  // Interface Settings
  // ----------------------------------------------------------
  interface: z.object({
    autocloseModal: opt(
      z.boolean().default(true),
      {
        label: 'Auto-close startup modal',
        description: 'Automatically close the loading modal when ready',
        group: 'interface',
        filter: 'global',
        order: 0,
        control: 'toggle',
      }
    ),
  }),

  // ----------------------------------------------------------
  // GPU Settings
  // ----------------------------------------------------------
  gpu: z.object({
    timeslotsPerLayer: opt(
      z.enum(['2', '3', '4', '8', '16', '32', '64', '128', '256', '512']).default('4'),
      {
        label: 'Timeslots per layer',
        description: 'More timeslots = smoother time scrubbing, more GPU memory',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 2,
        control: 'select',
        options: [
          // Memory = slots × 27 MB × 4 slabs (temp + pressure + wind U/V)
          { value: '2', label: '2 (216 MB) - Stress test', localhostOnly: true },
          { value: '3', label: '3 (324 MB) - Minimum' },
          { value: '4', label: '4 (432 MB) - Usable' },
          { value: '8', label: '8 (864 MB) - Comfortable' },
          { value: '16', label: '16 (1.7 GB) - Smooth' },
          { value: '32', label: '32 (3.5 GB) - Standard' },
          { value: '64', label: '64 (6.9 GB) - Extended' },
          { value: '128', label: '128 (13.8 GB) - Pro' },
          { value: '256', label: '256 (27.6 GB) - Ultra' },
          { value: '512', label: '512 (55 GB) - Max' },
        ],
      }
    ),
    showGpuStats: opt(
      z.boolean().default(false),
      {
        label: 'Show GPU stats',
        description: 'Display GPU memory usage in download panel',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 4,
        control: 'toggle',
      }
    ),
    workerPoolSize: opt(
      z.enum(['2', '4', '6', '8', '10', '12', '14', '16']).default('4'),
      {
        label: 'Decoder threads',
        description: 'Parallel WASM decoders (~30 MB each)',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 3,
        control: 'select',
        options: [
          { value: '2', label: '2' },
          { value: '4', label: '4' },
          { value: '6', label: '6', maxCores: 7 },
          { value: '8', label: '8', maxCores: 9 },
          { value: '10', label: '10', maxCores: 11 },
          { value: '12', label: '12', maxCores: 13 },
          { value: '14', label: '14', maxCores: 15 },
          { value: '16', label: '16', maxCores: 17 },
        ],
      }
    ),
  }),

  // ----------------------------------------------------------
  // Viewport / Interaction
  // ----------------------------------------------------------
  viewport: z.object({
    physicsModel: opt(
      z.enum(['inertia', 'velocity']).default('inertia'),
      {
        label: 'Physics model',
        description: 'Globe rotation feel',
        group: 'interaction',
        filter: 'global',
        order: 1,
        control: 'radio',
        options: [
          { value: 'inertia', label: 'Inertia' },
          { value: 'velocity', label: 'Velocity' },
        ],
      }
    ),
    mass: opt(
      z.number().min(1).max(10).default(5),
      {
        label: 'Mass',
        description: 'Higher = heavier feel, more momentum',
        group: 'interaction',
        filter: 'global',
        order: 2,
        control: 'slider',
        min: 1,
        max: 10,
        step: 1,
        model: 'inertia',
      }
    ),
    inertiaFriction: opt(
      z.number().min(0.1).max(0.9).default(0.5),
      {
        label: 'Friction',
        description: 'Higher = stops faster',
        group: 'interaction',
        filter: 'global',
        order: 3,
        control: 'slider',
        min: 0.1,
        max: 0.9,
        step: 0.1,
        model: 'inertia',
      }
    ),
    friction: opt(
      z.number().min(0.85).max(0.99).default(0.949),
      {
        label: 'Friction',
        description: 'Higher = spins longer',
        group: 'interaction',
        filter: 'global',
        order: 3,
        control: 'slider',
        min: 0.85,
        max: 0.99,
        step: 0.005,
        model: 'velocity',
      }
    ),

    tapToZoom: opt(
      z.enum(['off', 'single', 'double']).default('double'),
      {
        label: 'Tap to zoom',
        description: 'Tap on globe to zoom in (touch devices)',
        group: 'interaction',
        filter: 'global',
        order: 5,
        control: 'radio',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'single', label: 'Single tap' },
          { value: 'double', label: 'Double tap' },
        ],
        device: 'touch',
      }
    ),

    mouse: z.object({
      drag: z.object({
        sensitivity: opt(
          z.number().min(0.001).max(0.02).default(0.005),
          {
            label: 'Drag sensitivity',
            description: 'How fast the globe rotates when dragging',
            group: 'advanced',
            filter: 'global',
            order: 10,
            control: 'slider',
            min: 0.001,
            max: 0.02,
            step: 0.001,
            device: 'mouse',
          }
        ),
        invert: opt(
          z.boolean().default(false),
          {
            label: 'Invert drag',
            description: 'Reverse drag direction',
            group: 'advanced',
            filter: 'global',
            order: 11,
            control: 'toggle',
            device: 'mouse',
          }
        ),
      }),
      wheel: z.object({
        zoom: z.object({
          speed: opt(
            z.number().min(0.1).max(2.0).default(0.8),
            {
              label: 'Zoom speed',
              description: 'Mouse wheel zoom sensitivity',
              group: 'advanced',
              filter: 'global',
              order: 12,
              control: 'slider',
              min: 0.1,
              max: 2.0,
              step: 0.1,
              device: 'mouse',
            }
          ),
          invert: opt(
            z.boolean().default(false),
            {
              label: 'Invert zoom',
              description: 'Reverse scroll wheel zoom direction',
              group: 'advanced',
              filter: 'global',
              order: 13,
              control: 'toggle',
              device: 'mouse',
            }
          ),
        }),
        time: z.object({
          invert: opt(
            z.boolean().default(false),
            {
              label: 'Invert time scroll',
              description: 'Reverse horizontal scroll direction for time',
              group: 'advanced',
              filter: 'global',
              order: 14,
              control: 'toggle',
              device: 'mouse',
            }
          ),
        }),
      }),
    }),

    touch: z.object({
      oneFingerDrag: z.object({
        sensitivity: opt(
          z.number().min(0.001).max(0.02).default(0.005),
          {
            label: 'Drag sensitivity',
            description: 'How fast the globe rotates when dragging',
            group: 'advanced',
            filter: 'global',
            order: 20,
            control: 'slider',
            min: 0.001,
            max: 0.02,
            step: 0.001,
            device: 'touch',
          }
        ),
        invert: opt(
          z.boolean().default(false),
          {
            label: 'Invert drag',
            description: 'Reverse drag direction',
            group: 'advanced',
            filter: 'global',
            order: 21,
            control: 'toggle',
            device: 'touch',
          }
        ),
      }),
      twoFingerPinch: z.object({
        speed: opt(
          z.number().min(0.1).max(2.0).default(0.8),
          {
            label: 'Pinch zoom speed',
            description: 'Two-finger pinch zoom sensitivity',
            group: 'advanced',
            filter: 'global',
            order: 22,
            control: 'slider',
            min: 0.1,
            max: 2.0,
            step: 0.1,
            device: 'touch',
          }
        ),
        invert: opt(
          z.boolean().default(false),
          {
            label: 'Invert pinch zoom',
            description: 'Reverse pinch zoom direction',
            group: 'advanced',
            filter: 'global',
            order: 23,
            control: 'toggle',
            device: 'touch',
          }
        ),
      }),
      twoFingerPan: z.object({
        invert: opt(
          z.boolean().default(false),
          {
            label: 'Invert time pan',
            description: 'Reverse two-finger pan direction for time',
            group: 'advanced',
            filter: 'global',
            order: 24,
            control: 'toggle',
            device: 'touch',
          }
        ),
      }),
    }),
  }),

  // ----------------------------------------------------------
  // Layer: Earth
  // ----------------------------------------------------------
  earth: z.object({
    enabled: opt(
      z.boolean().default(true),
      {
        label: 'Show earth',
        description: 'Display earth basemap',
        group: 'layers',
        filter: ['global', 'earth'],
        order: 0,
        control: 'toggle',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(1),
      {
        label: 'Earth opacity',
        description: 'Transparency of earth basemap',
        group: 'layers',
        filter: ['global', 'earth'],
        order: 0,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Sun
  // ----------------------------------------------------------
  sun: z.object({
    enabled: opt(
      z.boolean().default(true),
      {
        label: 'Day/night shading',
        description: 'Show sun position and day/night terminator',
        group: 'layers',
        filter: ['global', 'sun'],
        order: 2,
        control: 'toggle',
      }
    ),
    opacity: opt(
      z.number().min(0).max(1).default(1),
      {
        label: 'Sun opacity',
        group: 'layers',
        filter: ['sun'],
        order: 3,
        control: 'slider',
        min: 0,
        max: 1,
        step: 0.1,
        hidden: true,  // Internal use for animation, not user-facing
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Grid (Graticule)
  // ----------------------------------------------------------
  grid: z.object({
    enabled: opt(
      z.boolean().default(true),
      {
        label: 'Show grid',
        description: 'Display latitude/longitude lines',
        group: 'layers',
        filter: ['global', 'grid'],
        order: 3,
        control: 'toggle',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.3),
      {
        label: 'Grid opacity',
        description: 'Transparency of grid lines',
        group: 'layers',
        filter: ['global', 'grid'],
        order: 4,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    fontSize: opt(
      z.number().min(2).max(16).default(12),
      {
        label: 'Label size',
        description: 'Font size for grid coordinate labels',
        group: 'layers',
        filter: ['global', 'grid'],
        order: 5,
        control: 'slider',
        min: 2,
        max: 16,
        step: 1,
      }
    ),
    lineWidth: opt(
      z.number().min(1).max(5).default(1),
      {
        label: 'Line width',
        description: 'Width of grid lines in pixels',
        group: 'layers',
        filter: ['global', 'grid'],
        order: 6,
        control: 'slider',
        min: 1,
        max: 5,
        step: 0.5,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Temperature
  // ----------------------------------------------------------
  temp: z.object({
    enabled: opt(
      z.boolean().default(true),
      {
        label: 'Temperature',
        description: 'Show temperature overlay',
        group: 'layers',
        filter: 'temp',
        order: 10,
        control: 'toggle',
        persist: 'url',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.6),
      {
        label: 'Temperature opacity',
        description: 'Transparency of temperature layer',
        group: 'layers',
        filter: ['global', 'temp'],
        order: 10,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    palette: opt(
      z.string().default('Hypatia Temperature'),
      {
        label: 'Color palette',
        description: 'Visual color scheme for temperature data',
        group: 'layers',
        filter: ['global', 'temp'],
        order: 10.3,
        control: 'select',
        options: [],
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Precipitation
  // ----------------------------------------------------------
  rain: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Precipitation',
        description: 'Show rain/snow overlay',
        group: 'layers',
        filter: 'rain',
        order: 11,
        control: 'toggle',
        persist: 'url',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(1.0),
      {
        label: 'Precipitation opacity',
        description: 'Transparency of rain layer',
        group: 'layers',
        filter: ['global', 'rain'],
        order: 11,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Clouds
  // ----------------------------------------------------------
  clouds: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Clouds',
        description: 'Show cloud cover overlay',
        group: 'layers',
        filter: 'clouds',
        order: 12,
        control: 'toggle',
        persist: 'url',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.5),
      {
        label: 'Cloud opacity',
        description: 'Transparency of cloud layer',
        group: 'layers',
        filter: ['global', 'clouds'],
        order: 12,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Humidity
  // ----------------------------------------------------------
  humidity: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Humidity',
        description: 'Show relative humidity overlay',
        group: 'layers',
        filter: 'humidity',
        order: 13,
        control: 'toggle',
        persist: 'url',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.6),
      {
        label: 'Humidity opacity',
        description: 'Transparency of humidity layer',
        group: 'layers',
        filter: ['global', 'humidity'],
        order: 13,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Wind
  // ----------------------------------------------------------
  wind: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Wind',
        description: 'Show animated wind particles',
        group: 'layers',
        filter: 'wind',
        order: 14,
        control: 'toggle',
        persist: 'url',
      }
    ),
    seedCount: opt(
      z.union([z.literal(8192), z.literal(16384), z.literal(32768), z.literal(49152), z.literal(65536)]).default(defaultConfig.wind.seedCount),
      {
        label: 'Wind line count',
        description: 'Number of animated wind lines (affects performance)',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 14,
        control: 'radio',
        options: [
          { value: 8192, label: '8K' },
          { value: 16384, label: '16K' },
          { value: 32768, label: '32K' },
          { value: 49152, label: '48K' },
          { value: 65536, label: '64K' },
        ],
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(defaultConfig.wind.opacity),
      {
        label: 'Wind opacity',
        description: 'Transparency of wind lines',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 15,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    speed: opt(
      z.number().min(10).max(60).default(defaultConfig.wind.animSpeed),
      {
        label: 'Animation speed',
        description: 'Speed of wind line animation (updates per second)',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 16,
        control: 'slider',
        min: 10,
        max: 60,
        step: 10,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Pressure
  // ----------------------------------------------------------
  pressure: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Pressure',
        description: 'Show isobar contour lines',
        group: 'layers',
        filter: 'pressure',
        order: 17,
        control: 'toggle',
        persist: 'url',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.85),
      {
        label: 'Pressure opacity',
        description: 'Transparency of isobar lines',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 17,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    resolution: opt(
      z.enum(['1', '2']).default('2'),
      {
        label: 'Grid resolution',
        description: 'Contour grid resolution (1° = finer, 2° = faster)',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 17.5,
        control: 'radio',
        options: [
          { value: '2', label: '2° (fast)' },
          { value: '1', label: '1° (detailed)' },
        ],
      }
    ),
    smoothing: opt(
      z.enum(['0', '1', '2']).default('1'),
      {
        label: 'Line smoothing',
        description: 'Chaikin subdivision iterations for smoother contours',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 18,
        control: 'radio',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: '1 pass' },
          { value: '2', label: '2 passes' },
        ],
      }
    ),
    spacing: opt(
      z.enum(['4', '6', '8', '10']).default('4'),
      {
        label: 'Isobar spacing',
        description: 'Pressure difference between contour lines (hPa)',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 19,
        control: 'radio',
        options: [
          { value: '4', label: '4 hPa' },
          { value: '6', label: '6 hPa' },
          { value: '8', label: '8 hPa' },
          { value: '10', label: '10 hPa' },
        ],
      }
    ),
    colors: opt(
      PressureColorOptionSchema.default(PRESSURE_COLOR_DEFAULT),
      {
        label: 'Line colors',
        description: 'Color scheme for isobar lines',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 19.5,
        control: 'pressure-colors',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Data Cache
  // ----------------------------------------------------------
  dataCache: z.object({
    cacheStrategy: opt(
      z.enum(['future-first', 'alternate']).default('alternate'),
      {
        label: 'Strategy',
        description: 'How to prioritize and order loading timesteps',
        group: 'performance',
        filter: ['global', 'dataCache', 'queue'],
        order: 0,
        control: 'radio',
        options: [
          { value: 'alternate', label: 'Balanced' },
          { value: 'future-first', label: 'Future first' },
        ],
      }
    ),
  }),

  // ----------------------------------------------------------
  // Background Prefetch
  // ----------------------------------------------------------
  prefetch: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Background prefetch',
        description: 'Download forecast data when browser is closed. Chrome and Edge only. Browser decides when to run, typically overnight. May not run on battery or with low site engagement.',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 10,
        control: 'toggle',
      }
    ),
    forecastDays: opt(
      z.enum(['1', '2', '4', '6', '8']).default('2'),
      {
        label: 'Forecast days',
        description: 'Days of forecast to download in background',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 11,
        control: 'select',
        options: [
          { value: '1', label: '1 day' },
          { value: '2', label: '2 days' },
          { value: '4', label: '4 days' },
          { value: '6', label: '6 days' },
          { value: '8', label: '8 days' },
        ],
      }
    ),
    temp: opt(
      z.boolean().default(true),
      {
        label: 'Temperature',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 12,
        control: 'layer-toggle',
        layerId: 'temp',
      }
    ),
    pressure: opt(
      z.boolean().default(false),
      {
        label: 'Pressure',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 13,
        control: 'layer-toggle',
        layerId: 'pressure',
      }
    ),
    wind: opt(
      z.boolean().default(false),
      {
        label: 'Wind',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 14,
        control: 'layer-toggle',
        layerId: 'wind',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Debug
  // ----------------------------------------------------------
  debug: z.object({
    showPerfPanel: opt(
      z.boolean().default(false),
      {
        label: 'Show perf panel',
        description: 'Frame and GPU pass timing',
        group: 'advanced',
        filter: 'global',
        order: 100,
        control: 'toggle',
      }
    ),
    batterySaver: opt(
      z.boolean().default(false),
      {
        label: 'Battery saver',
        description: 'Limit to 30 fps to save power and reduce heat',
        group: 'environmental',
        filter: 'global',
        order: 0,
        control: 'toggle',
      }
    ),
  }),
});

// ============================================================
// Derived Types
// ============================================================

export type ZeroOptions = z.infer<typeof optionsSchema>;

export const defaultOptions: ZeroOptions = {
  _version: 1,
  interface: { autocloseModal: true },
  gpu: { timeslotsPerLayer: '4', showGpuStats: false, workerPoolSize: '4' },
  viewport: {
    physicsModel: 'inertia',
    mass: 5,
    inertiaFriction: 0.5,
    friction: 0.949,
    tapToZoom: 'double',
    mouse: {
      drag: { sensitivity: 0.005, invert: false },
      wheel: {
        zoom: { speed: 0.8, invert: false },
        time: { invert: false },
      },
    },
    touch: {
      oneFingerDrag: { sensitivity: 0.005, invert: false },
      twoFingerPinch: { speed: 0.8, invert: false },
      twoFingerPan: { invert: false },
    },
  },
  earth: { enabled: true, opacity: 1 },
  sun: { enabled: true, opacity: 1 },
  grid: { enabled: true, opacity: defaultConfig.grid.opacity, fontSize: 12, lineWidth: 2 },
  temp: { enabled: true, opacity: 0.6, palette: 'Hypatia Temperature' },
  rain: { enabled: false, opacity: 1.0 },
  clouds: { enabled: false, opacity: 0.5 },
  humidity: { enabled: false, opacity: 0.6 },
  wind: { enabled: false, seedCount: defaultConfig.wind.seedCount, opacity: defaultConfig.wind.opacity, speed: defaultConfig.wind.animSpeed },
  pressure: { enabled: false, opacity: 0.85, resolution: '2', smoothing: '1', spacing: '4', colors: PRESSURE_COLOR_DEFAULT },
  dataCache: { cacheStrategy: 'alternate' },
  prefetch: { enabled: false, forecastDays: '2', temp: true, pressure: false, wind: false },
  debug: { showPerfPanel: false, batterySaver: false },
};

// ============================================================
// Utility: Extract metadata from schema
// ============================================================

interface FlatOption {
  path: string;
  meta: OptionMeta;
  schema: z.ZodTypeAny;
}

export function extractOptionsMeta(
  schema: z.ZodTypeAny = optionsSchema,
  path: string[] = []
): FlatOption[] {
  const results: FlatOption[] = [];

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    for (const [key, value] of Object.entries(shape)) {
      const childPath = [...path, key];
      const zodValue = value as z.ZodTypeAny;

      if ('_meta' in zodValue) {
        results.push({
          path: childPath.join('.'),
          meta: (zodValue as { _meta: OptionMeta })._meta,
          schema: zodValue,
        });
      }

      results.push(...extractOptionsMeta(zodValue, childPath));
    }
  } else if ('_def' in schema && schema._def && 'innerType' in schema._def) {
    results.push(...extractOptionsMeta(schema._def.innerType as z.ZodTypeAny, path));
  }

  return results;
}

/** Get all options grouped by group ID */
export function getOptionsGrouped() {
  const flat = extractOptionsMeta();
  const grouped: Record<string, FlatOption[]> = {};

  for (const opt of flat) {
    const group = opt.meta.group;
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(opt);
  }

  for (const group of Object.values(grouped)) {
    group.sort((a, b) => a.meta.order - b.meta.order);
  }

  return grouped;
}

/** Get options filtered by entry point */
export function getOptionsFiltered(filter: OptionFilter) {
  const flat = extractOptionsMeta();
  return flat.filter(opt => {
    const f = opt.meta.filter;
    return Array.isArray(f) ? f.includes(filter) : f === filter;
  });
}

let optionMetaCache: Map<string, OptionMeta> | null = null;

export function getOptionMeta(path: string): OptionMeta | undefined {
  if (!optionMetaCache) {
    optionMetaCache = new Map();
    for (const opt of extractOptionsMeta()) {
      optionMetaCache.set(opt.path, opt.meta);
    }
  }
  return optionMetaCache.get(path);
}

export type { OptionMeta, OptionFilter, OptionImpact, FlatOption };
