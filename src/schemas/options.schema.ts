/**
 * Options Schema - Single source of truth for user-configurable options
 *
 * Uses Zod for validation + UI metadata for form generation.
 * Filter field determines which entry points show each option.
 */

import { z } from 'zod';

// ============================================================
// UI Metadata Types
// ============================================================

type ControlType = 'toggle' | 'slider' | 'select' | 'radio';

/** Impact level for option changes */
type OptionImpact = 'uniform' | 'recreate';

/** Filter determines which dialog entry points show this option */
type OptionFilter = 'global' | 'earth' | 'sun' | 'grid' | 'temp' | 'rain' | 'wind' | 'clouds' | 'humidity' | 'pressure' | 'dataCache' | 'gpu';

interface UIMetadata {
  label: string;
  description?: string;
  group: 'regional' | 'download' | 'interaction' | 'layers' | 'gpu' | 'advanced';
  filter: OptionFilter | OptionFilter[];
  order: number;
  control: ControlType;
  advanced?: boolean;
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
  options: { value: string | number; label: string }[];
}

interface ToggleMeta extends UIMetadata {
  control: 'toggle';
}

interface RadioMeta extends UIMetadata {
  control: 'radio';
  options: { value: string | number; label: string }[];
}

type OptionMeta = SliderMeta | SelectMeta | ToggleMeta | RadioMeta;

/** Helper to attach metadata to Zod schema */
function opt<T extends z.ZodTypeAny>(schema: T, meta: OptionMeta): T & { _meta: OptionMeta } {
  return Object.assign(schema, { _meta: meta });
}

// ============================================================
// Group Definitions
// ============================================================

export const optionGroups = {
  regional: {
    id: 'regional',
    label: 'Regional',
    description: 'Location and unit preferences',
    order: 1,
  },
  download: {
    id: 'download',
    label: 'Download',
    description: 'Data loading and caching',
    order: 2,
  },
  interaction: {
    id: 'interaction',
    label: 'Interaction',
    description: 'Controls and input settings',
    order: 3,
  },
  layers: {
    id: 'layers',
    label: 'Layers',
    description: 'Visual appearance of map layers',
    order: 4,
  },
  gpu: {
    id: 'gpu',
    label: 'GPU',
    description: 'Graphics memory and performance',
    order: 5,
  },
  advanced: {
    id: 'advanced',
    label: 'Advanced',
    description: 'Fine-tuning and experimental options',
    order: 6,
  },
} as const;

// ============================================================
// Options Schema
// ============================================================

export const optionsSchema = z.object({
  _version: z.number().default(1),

  // ----------------------------------------------------------
  // GPU Settings
  // ----------------------------------------------------------
  gpu: z.object({
    slotsPerLayer: opt(
      z.enum(['4', '8', '16', '32', '64']).default('8'),
      {
        label: 'Slots per layer',
        description: 'More slots = smoother time scrubbing, more GPU memory',
        group: 'gpu',
        filter: ['global', 'gpu'],
        order: 0,
        control: 'select',
        options: [
          { value: '4', label: '4 (108 MB) - Minimum' },
          { value: '8', label: '8 (216 MB) - Good' },
          { value: '16', label: '16 (432 MB) - Smooth' },
          { value: '32', label: '32 (864 MB) - Maximum' },
          { value: '64', label: '64 (1.7 GB) - Debug' },
        ],
        impact: 'recreate',
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
      z.number().min(1).max(20).default(10),
      {
        label: 'Mass',
        description: 'Higher = heavier feel, more momentum',
        group: 'interaction',
        filter: 'global',
        order: 2,
        control: 'slider',
        min: 1,
        max: 20,
        step: 1,
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
        order: 2,
        control: 'slider',
        min: 0.85,
        max: 0.99,
        step: 0.005,
        model: 'velocity',
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
    }),
  }),

  // ----------------------------------------------------------
  // Layer: Earth
  // ----------------------------------------------------------
  earth: z.object({
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
    blend: opt(
      z.number().min(0).max(1).default(0),
      {
        label: 'Basemap blend',
        description: 'Blend between satellite (0) and terrain (1)',
        group: 'layers',
        filter: ['global', 'earth'],
        order: 1,
        control: 'slider',
        min: 0,
        max: 1,
        step: 0.1,
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
      z.number().min(8).max(32).default(14),
      {
        label: 'Label size',
        description: 'Font size for grid coordinate labels',
        group: 'layers',
        filter: ['global', 'grid'],
        order: 5,
        control: 'slider',
        min: 8,
        max: 32,
        step: 2,
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Temperature
  // ----------------------------------------------------------
  temp: z.object({
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
    resolution: opt(
      z.enum(['0p25', '0p5', '1p0']).default('0p25'),
      {
        label: 'Grid resolution',
        description: 'Higher resolution = more detail but larger downloads',
        group: 'layers',
        filter: ['global', 'temp'],
        order: 10.5,
        control: 'radio',
        options: [
          { value: '0p25', label: 'High' },
          { value: '0p5', label: 'Med' },
          { value: '1p0', label: 'Low' },
        ],
        impact: 'recreate',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Precipitation
  // ----------------------------------------------------------
  rain: z.object({
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
    resolution: opt(
      z.enum(['0p25', '0p5', '1p0']).default('0p25'),
      {
        label: 'Grid resolution',
        description: 'High has 3-hour updates, others 6-hour',
        group: 'layers',
        filter: ['global', 'rain'],
        order: 11.5,
        control: 'radio',
        options: [
          { value: '0p25', label: 'High' },
          { value: '0p5', label: 'Med' },
          { value: '1p0', label: 'Low' },
        ],
        impact: 'recreate',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Clouds
  // ----------------------------------------------------------
  clouds: z.object({
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
    resolution: opt(
      z.enum(['0p25', '0p5', '1p0']).default('0p25'),
      {
        label: 'Grid resolution',
        description: 'High has 3-hour updates, others 6-hour',
        group: 'layers',
        filter: ['global', 'clouds'],
        order: 12.5,
        control: 'radio',
        options: [
          { value: '0p25', label: 'High' },
          { value: '0p5', label: 'Med' },
          { value: '1p0', label: 'Low' },
        ],
        impact: 'recreate',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Humidity
  // ----------------------------------------------------------
  humidity: z.object({
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
    resolution: opt(
      z.enum(['0p25', '0p5', '1p0']).default('0p25'),
      {
        label: 'Grid resolution',
        description: 'High has 3-hour updates, others 6-hour',
        group: 'layers',
        filter: ['global', 'humidity'],
        order: 13.5,
        control: 'radio',
        options: [
          { value: '0p25', label: 'High' },
          { value: '0p5', label: 'Med' },
          { value: '1p0', label: 'Low' },
        ],
        impact: 'recreate',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Wind
  // ----------------------------------------------------------
  wind: z.object({
    seedCount: opt(
      z.enum(['8192', '16384', '32768']).default('8192'),
      {
        label: 'Wind line count',
        description: 'Number of animated wind lines (affects performance)',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 14,
        control: 'radio',
        options: [
          { value: '8192', label: '8K' },
          { value: '16384', label: '16K' },
          { value: '32768', label: '32K' },
        ],
      }
    ),
    opacity: opt(
      z.number().min(0.05).max(1).default(0.6),
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
      z.number().min(5).max(50).default(20),
      {
        label: 'Animation speed',
        description: 'Speed of wind line animation',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 16,
        control: 'slider',
        min: 5,
        max: 50,
        step: 5,
      }
    ),
    resolution: opt(
      z.enum(['0p25', '0p5', '1p0']).default('0p25'),
      {
        label: 'Grid resolution',
        description: 'Higher resolution = more detail but larger downloads',
        group: 'layers',
        filter: ['global', 'wind'],
        order: 16.5,
        control: 'radio',
        options: [
          { value: '0p25', label: 'High' },
          { value: '0p5', label: 'Med' },
          { value: '1p0', label: 'Low' },
        ],
        impact: 'recreate',
      }
    ),
  }),

  // ----------------------------------------------------------
  // Layer: Pressure
  // ----------------------------------------------------------
  pressure: z.object({
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
      z.enum(['0', '1', '2', '3']).default('1'),
      {
        label: 'Line smoothing',
        description: 'Chaikin subdivision iterations for smoother contours',
        group: 'layers',
        filter: ['global', 'pressure'],
        order: 18,
        control: 'radio',
        options: [
          { value: '0', label: 'Off' },
          { value: '1', label: 'Low' },
          { value: '2', label: 'Med' },
          { value: '3', label: 'High' },
        ],
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
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 0,
        control: 'radio',
        options: [
          { value: 'alternate', label: 'Balanced' },
          { value: 'future-first', label: 'Future first' },
        ],
      }
    ),
    downloadMode: opt(
      z.enum(['on-demand', 'aggressive']).default('on-demand'),
      {
        label: 'Mode',
        description: 'When to fetch data files',
        group: 'download',
        filter: ['global', 'dataCache'],
        order: 1,
        control: 'radio',
        options: [
          { value: 'on-demand', label: 'On demand' },
          { value: 'aggressive', label: 'Eager' },
        ],
      }
    ),
  }),

  // ----------------------------------------------------------
  // Debug
  // ----------------------------------------------------------
  debug: z.object({
    showDevLog: opt(
      z.boolean().default(false),
      {
        label: 'Show dev log',
        description: 'On-screen debug messages',
        group: 'advanced',
        filter: 'global',
        order: 99,
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
  gpu: { slotsPerLayer: '8' },
  viewport: {
    physicsModel: 'inertia',
    mass: 10,
    friction: 0.949,
    mouse: {
      drag: { sensitivity: 0.005, invert: false },
      wheel: { zoom: { speed: 0.8, invert: false } },
    },
    touch: {
      oneFingerDrag: { sensitivity: 0.005, invert: false },
      twoFingerPinch: { speed: 0.8, invert: false },
    },
  },
  earth: { opacity: 1, blend: 0 },
  sun: { enabled: true },
  grid: { enabled: true, opacity: 0.3, fontSize: 14 },
  temp: { opacity: 0.6, resolution: '0p25' },
  rain: { opacity: 1.0, resolution: '0p25' },
  clouds: { opacity: 0.5, resolution: '0p25' },
  humidity: { opacity: 0.6, resolution: '0p25' },
  wind: { seedCount: '8192', opacity: 0.6, speed: 20, resolution: '0p25' },
  pressure: { opacity: 0.85, smoothing: '1' },
  dataCache: { cacheStrategy: 'alternate', downloadMode: 'on-demand' },
  debug: { showDevLog: false },
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
