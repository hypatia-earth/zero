/**
 * Options Schema - Single source of truth for user-configurable options
 *
 * Uses Zod for validation + UI metadata for form generation.
 * Filter field determines which entry points show each option.
 */

import { z } from 'zod';
import type { TLayer } from '../config/types';
import { getPaletteIdsEnum } from '../services/palette-service';

// ============================================================
// UI Metadata Types
// ============================================================

type ControlType = 'toggle' | 'slider' | 'select' | 'radio' | 'color-chips' | 'pressure-colors' | 'layer-toggle';

/** Impact level for option changes */
type OptionImpact = 'uniform' | 'recreate';

/** Persistence mode: 'url' for shareable view state, 'local' for user preferences */
type PersistMode = 'url' | 'local';

/** Filter determines which dialog entry points show this option */
type OptionFilter = TLayer | 'global' | 'dataCache' | 'gpu' | 'queue' | 'capture';

interface UIMetadata {
  label: string;
  description?: string;
  group: 'interface' | 'regional' | 'download' | 'environmental' | 'interaction' | 'layers' | 'gpu' | 'capture' | 'advanced' | 'performance';
  filter: OptionFilter | OptionFilter[];
  order: number;
  control: ControlType;
  persist?: PersistMode;  // default: 'local'
  advanced?: boolean;
  hidden?: boolean;       // Hide from options dialog (for internal use)
  disabled?: boolean;     // Show but disable in options dialog
  disabledWhen?: { path: string; equals: unknown };  // Conditionally disable based on another option's value
  model?: 'inertia' | 'velocity';
  device?: 'mouse' | 'touch';
  impact?: OptionImpact;
  uniform?: { type: string; pos: number };  // GPU uniform binding
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
  options: { value: string | number; label: string; localhostOnly?: boolean; minBufferSizeMB?: number }[];
}

interface ColorChipsMeta extends UIMetadata {
  control: 'color-chips';
  options: { value: string; label: string; color: string }[];
}

interface PressureColorsMeta extends UIMetadata {
  control: 'pressure-colors';
}

interface LayerToggleMeta extends UIMetadata {
  control: 'layer-toggle';
  layerId: string;  // For CSS color variable lookup
}

type OptionMeta = SliderMeta | SelectMeta | ToggleMeta | RadioMeta | ColorChipsMeta | PressureColorsMeta | LayerToggleMeta;

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
  capture: {
    id: 'capture',
    label: 'Capture',
    description: 'GIF recording settings',
    order: 8,
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
    mode: z.literal('palette'),
    paletteId: z.string(),
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
    minDownloads: opt(
      z.number().min(2).max(8).default(4),
      {
        label: 'Min parallel downloads',
        description: 'Starting concurrent network requests',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 4.1,
        control: 'slider',
        min: 2,
        max: 8,
        step: 1,
      }
    ),
    maxDownloads: opt(
      z.number().min(8).max(16).default(12),
      {
        label: 'Max parallel downloads',
        description: 'Upper limit for adaptive concurrency',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 4.2,
        control: 'slider',
        min: 8,
        max: 16,
        step: 1,
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
            z.number().min(0.1).max(2.0).default(0.3),
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
  // Layer: Graticule (lat/lon grid overlay)
  // ----------------------------------------------------------
  graticule: z.object({
    enabled: opt(
      z.boolean().default(true),
      {
        label: 'Show grid',
        description: 'Display latitude/longitude lines',
        group: 'layers',
        filter: ['global', 'graticule'],
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
        filter: ['global', 'graticule'],
        order: 4,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    fontSize: opt(
      z.number().min(8).max(24).default(12),
      {
        label: 'Label size',
        description: 'Font size for graticule coordinate labels',
        group: 'layers',
        filter: ['global', 'graticule'],
        order: 5,
        control: 'slider',
        min: 8,
        max: 24,
        step: 1,
        // No uniform: here — GraticuleLayer.onOptionsChanged caches the CSS-pixel
        // value and writes (value × frame.dpr) to U.graticuleFontSize each frame.
      }
    ),
    lineWidth: opt(
      z.number().min(1).max(5).default(1),
      {
        label: 'Line width',
        description: 'Width of graticule lines in pixels',
        group: 'layers',
        filter: ['global', 'graticule'],
        order: 6,
        control: 'slider',
        min: 1,
        max: 5,
        step: 0.5,
        // No uniform: here — GraticuleLayer.onOptionsChanged caches the CSS-pixel
        // value and writes (value × frame.dpr) to U.graticuleLineWidth each frame.
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Cities
  // ----------------------------------------------------------
  cities: z.object({
    enabled: opt(
      z.boolean().default(false),
      {
        label: 'Show cities',
        description: 'Display cities with population > 100,000 on the globe',
        group: 'layers',
        filter: ['global', 'cities'],
        order: 3.5,
        control: 'toggle',
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.8),
      {
        label: 'City label opacity',
        description: 'Transparency of city labels',
        group: 'layers',
        filter: ['global', 'cities'],
        order: 3.6,
        control: 'slider',
        min: 0.05,
        max: 1,
        step: 0.05,
      }
    ),
    color: opt(
      z.enum(['white', 'black', 'darkred', 'gold']).default('white'),
      {
        label: 'Label color',
        description: 'Color of city labels and indicators',
        group: 'layers',
        filter: ['global', 'cities'],
        order: 3.7,
        control: 'color-chips',
        options: [
          { value: 'white', label: 'White', color: '#ffffff' },
          { value: 'black', label: 'Black', color: '#000000' },
          { value: 'darkred', label: 'Dark Red', color: '#8c0d0d' },
          { value: 'gold', label: 'Gold', color: '#d9a621' },
        ],
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
      z.enum(getPaletteIdsEnum('temp')).default('temp-classic'),
      {
        label: 'Color palette',
        description: 'Visual color scheme for temperature data',
        group: 'layers',
        filter: ['global', 'temp'],
        order: 10.3,
        control: 'select',
        options: [
          { value: 'temp-classic', label: 'Classic' },
          { value: 'temp-hypatia', label: 'Hypatia' },
          { value: 'simple-gradient', label: 'Gradient' },
        ],
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
    animated: opt(
      z.boolean().default(true),
      {
        label: 'Animate particles',
        description: 'Animate precipitation particles',
        group: 'layers',
        filter: 'rain',
        order: 12,
        control: 'toggle',
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
      z.union([z.literal(8192), z.literal(16384), z.literal(32768), z.literal(49152), z.literal(65536)]).default(8192),
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
      z.number().min(0.05).max(1).default(0.8),
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
      z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]).default(30),
      {
        label: 'Animation speed',
        description: 'Speed of wind line animation (updates per second)',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 16,
        control: 'radio',
        options: [
          { value: 0, label: 'Frozen', localhostOnly: true },
          { value: 15, label: '15' },
          { value: 30, label: '30' },
          { value: 60, label: '60' },
        ],
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
    smoothing: opt(
      z.enum(['none', 'light']).default('light'),
      {
        label: 'Smoothing',
        description: 'Smooth isobar contour lines',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 18,
        control: 'radio',
        options: [
          { value: 'none', label: 'None' },
          { value: 'light', label: 'Light' },
          // 'strong' (2 Chaikin passes) disabled - drops every other line
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
  // OUTDATED: Per-layer toggles (temp/pressure/wind) should be removed.
  // Prefetch should download all published params — no user choice per param.
  // Size estimate should derive from params-ecmwf_ifs.ts sizeEstimate field.
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
  // Capture (GIF recording)
  // ----------------------------------------------------------
  capture: z.object({
    aspectRatio: opt(
      z.enum(['free', '16:9', '4:5', '1:1', '9:16']).default('free'),
      {
        label: 'Aspect ratio',
        description: 'Lock capture rect to aspect ratio',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 10,
        control: 'radio',
        options: [
          { value: 'free', label: 'Free' },
          { value: '16:9', label: '16:9' },
          { value: '4:5', label: '4:5' },
          { value: '1:1', label: '1:1' },
          { value: '9:16', label: '9:16' },
        ],
      }
    ),
    format: opt(
      z.enum(['gif', 'mp4']).default('gif'),
      {
        label: 'Format',
        description: 'Output format for recording',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 20,
        control: 'radio',
        options: [
          { value: 'gif', label: 'GIF' },
          { value: 'mp4', label: 'MP4' },
        ],
      }
    ),
    bitrate: opt(
      z.enum(['1', '3', '5']).default('3'),
      {
        label: 'Bitrate',
        description: 'MP4 encoding bitrate',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 25,
        control: 'radio',
        disabledWhen: { path: 'capture.format', equals: 'gif' },
        options: [
          { value: '1', label: '1 Mbps' },
          { value: '3', label: '3 Mbps' },
          { value: '5', label: '5 Mbps' },
        ],
      }
    ),
    duration: opt(
      z.enum(['1', '5', '10', '30', '60', '300']).default('5'),
      {
        label: 'Duration',
        description: 'Recording length in seconds',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 30,
        control: 'radio',
        options: [
          { value: '1', label: '1s' },
          { value: '5', label: '5s' },
          { value: '10', label: '10s' },
          { value: '30', label: '30s' },
          { value: '60', label: '1m' },
          { value: '300', label: '5m' },
        ],
      }
    ),
    fps: opt(
      z.enum(['15', '30']).default('15'),
      {
        label: 'FPS',
        description: 'Frames per second',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 40,
        control: 'radio',
        options: [
          { value: '15', label: '15' },
          { value: '30', label: '30' },
        ],
      }
    ),
    zoomInterp: opt(
      z.enum(['smooth', 'spline', 'linear']).default('smooth'),
      {
        label: 'Zoom curve',
        description: 'Altitude interpolation between keyframes',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 50,
        control: 'radio',
        disabledWhen: { path: 'capture.lastCaptureType', equals: 'simple' },
        options: [
          { value: 'smooth', label: 'Smooth' },
          { value: 'spline', label: 'Spline' },
          { value: 'linear', label: 'Linear' },
        ],
      }
    ),
    nativeDpr: opt(
      z.boolean().default(false),
      {
        label: 'Native resolution',
        description: `Record at device pixel resolution (${typeof window !== 'undefined' ? parseFloat(window.devicePixelRatio.toFixed(2)) : 2}× on this device)`,
        group: 'capture',
        filter: ['global', 'capture'],
        order: 60,
        control: 'toggle',
      }
    ),
    paletteMode: opt(
      z.enum(['fast', 'precise', 'grayscale']).default('fast'),
      {
        label: 'Palette',
        description: 'Color quantization strategy for GIF encoding',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 70,
        control: 'radio',
        disabledWhen: { path: 'capture.format', equals: 'mp4' },
        options: [
          { value: 'fast', label: 'Fast' },
          { value: 'precise', label: 'Precise' },
          { value: 'grayscale', label: 'Grayscale' },
        ],
      }
    ),
    label: opt(
      z.boolean().default(true),
      {
        label: 'Location label',
        description: 'Show location label in exported media',
        group: 'capture',
        filter: ['global', 'capture'],
        order: 80,
        control: 'toggle',
      }
    ),
    lastCaptureType: opt(
      z.enum(['simple', 'animated']).default('simple'),
      {
        label: 'Last capture type',
        group: 'capture',
        filter: 'capture',
        order: 100,
        control: 'toggle',
        hidden: true,
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
    fpsLimit: opt(
      z.enum(['off', '60', '30', '5']).default('off'),
      {
        label: 'Frame rate limit',
        description: 'Limit fps to save power and reduce heat',
        group: 'environmental',
        filter: 'global',
        order: 0,
        control: 'radio',
        options: [
          { value: 'off', label: 'Off' },
          { value: '60', label: '60' },
          { value: '30', label: '30' },
          { value: '5', label: '5', localhostOnly: true },
        ],
      }
    ),
    renderScale: opt(
      z.enum(['1', '2', '4']).default('1'),
      {
        label: 'Downscale',
        description: 'Reduce render resolution. Higher = faster but softer',
        group: 'environmental',
        filter: 'global',
        order: 1,
        control: 'radio',
        options: [
          { value: '1', label: 'Off' },
          { value: '2', label: '2x' },
          { value: '4', label: '4x' },
        ],
      }
    ),
    showLogo: opt(
      z.boolean().default(true),
      {
        label: 'Show logo',
        group: 'advanced',
        filter: 'global',
        order: 110,
        control: 'toggle',
        hidden: true,
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
  gpu: { timeslotsPerLayer: '4', showGpuStats: false, workerPoolSize: '4', minDownloads: 4, maxDownloads: 12 },
  viewport: {
    physicsModel: 'inertia',
    mass: 5,
    inertiaFriction: 0.5,
    friction: 0.949,
    tapToZoom: 'double',
    mouse: {
      drag: { sensitivity: 0.005, invert: false },
      wheel: {
        zoom: { speed: 0.3, invert: false },
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
  graticule: { enabled: true, opacity: 0.9, fontSize: 12, lineWidth: 1.5 },
  cities: { enabled: false, opacity: 0.8, color: 'white' },
  temp: { enabled: true, opacity: 0.6, palette: 'temp-classic' },
  rain: { enabled: false, opacity: 1, animated: true },
  clouds: { enabled: false, opacity: 0.5 },
  humidity: { enabled: false, opacity: 0.6 },
  wind: { enabled: false, seedCount: 8192, opacity: 0.8, speed: 30 },
  pressure: { enabled: false, opacity: 0.85, smoothing: 'light', spacing: '4', colors: PRESSURE_COLOR_DEFAULT },
  dataCache: { cacheStrategy: 'alternate' },
  prefetch: { enabled: false, forecastDays: '2', temp: true, pressure: false, wind: false },
  capture: { aspectRatio: 'free', duration: '5', fps: '15', zoomInterp: 'smooth', nativeDpr: false, paletteMode: 'fast', format: 'gif', bitrate: '3', label: true, lastCaptureType: 'simple' },
  debug: { showPerfPanel: false, fpsLimit: 'off', renderScale: '1', showLogo: true },
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

export type { OptionMeta, OptionFilter, OptionImpact, FlatOption, RadioMeta };
