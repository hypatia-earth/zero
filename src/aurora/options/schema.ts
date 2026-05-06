/**
 * Aurora Options Schema — Zod source of truth for aurora-owned options.
 *
 * Mirrors host's `optionsSchema` style: `opt(zod, _meta)` per leaf, with
 * `_meta` carrying full presentation (label, description, group, filter,
 * order, control, options[].label, hidden flags). Persisted shape derived
 * via `z.infer<typeof auroraOptionsSchema>`.
 *
 * Top-level: `engine` (engine-wide) and `layers.<id>` (per-built-in).
 * Each layer is `{ opacity, opts: { ... } }` to match aurora-db's runtime
 * `LayerEntry` shape (see `./index.ts` AuroraOptions class). Opacity is a
 * sibling of opts, not a member, so the worker's `setLayerOpacity` /
 * `setLayerOptions` split stays valid without an aurora-db migration.
 *
 * Walked by `extractOptionsMeta(auroraOptionsSchema)` in the dialog. The
 * worker receives a slim shape view at init time (no Zod imports in the
 * worker bundle). Aurora-db merge: `defaults < seeds < persisted`.
 */

import { z } from 'zod';
import { opt } from '../../schemas/options.schema';
import { PRESSURE_COLOR_DEFAULT } from './pressure-colors-default';

// ============================================================
// Pressure color option (moved from host's options.schema in F-A — schema
// is the canonical home for aurora-owned types). The runtime default
// `PRESSURE_COLOR_DEFAULT` lives in `./pressure-colors-default.ts` so
// worker-bundle code can import it without dragging Zod along.
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

// ============================================================
// Aurora Options Schema
// ============================================================

export const auroraOptionsSchema = z.object({
  // ----------------------------------------------------------
  // Engine — engine-wide settings persisted in aurora-db.
  // ----------------------------------------------------------
  engine: z.object({
    // Hidden in dialog until F-B (host's `gpu.timeslotsPerLayer` is the
    // visible row; aurora's entry exists so aurora-db carries the shape).
    timeslotsPerLayer: opt(
      z.union([
        z.literal(2), z.literal(3), z.literal(4), z.literal(8), z.literal(16),
        z.literal(32), z.literal(64), z.literal(128), z.literal(256), z.literal(512),
      ]).default(4),
      {
        label: 'Timeslots per layer',
        group: 'performance',
        filter: ['global', 'gpu', 'queue'],
        order: 2,
        control: 'select',
        options: [
          { value: 2, label: '2 (216 MB) - Stress test', localhostOnly: true },
          { value: 3, label: '3 (324 MB) - Minimum' },
          { value: 4, label: '4 (432 MB) - Usable' },
          { value: 8, label: '8 (864 MB) - Comfortable' },
          { value: 16, label: '16 (1.7 GB) - Smooth' },
          { value: 32, label: '32 (3.5 GB) - Standard' },
          { value: 64, label: '64 (6.9 GB) - Extended' },
          { value: 128, label: '128 (13.8 GB) - Pro' },
          { value: 256, label: '256 (27.6 GB) - Ultra' },
          { value: 512, label: '512 (55 GB) - Max' },
        ],
        hidden: true,
      },
    ),
    useTimestampQueries: opt(
      z.boolean().default(false),
      {
        label: 'Use GPU timestamp queries',
        description: 'Enable WebGPU timestamp queries for per-pass timings',
        group: 'advanced',
        filter: 'global',
        order: 105,
        control: 'toggle',
        hidden: true,
      },
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
      },
    ),
  }),

  // ----------------------------------------------------------
  // Layers — per-built-in options persisted in aurora-db. Each layer is
  // `{ opacity, opts: { ... } }` matching `LayerEntry` runtime shape.
  // ----------------------------------------------------------
  layers: z.object({
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
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({}).default({}),
    }),

    sun: z.object({
      opacity: opt(
        z.number().min(0).max(1).default(1),
        {
          label: 'Sun opacity',
          group: 'layers',
          filter: ['sun'],
          order: 3,
          control: 'slider',
          min: 0, max: 1, step: 0.1,
          hidden: true,
        },
      ),
      opts: z.object({}).default({}),
    }),

    graticule: z.object({
      opacity: opt(
        z.number().min(0.05).max(1).default(0.9),
        {
          label: 'Grid opacity',
          description: 'Transparency of grid lines',
          group: 'layers',
          filter: ['global', 'graticule'],
          order: 4,
          control: 'slider',
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({
        fontSize: opt(
          z.number().min(8).max(24).default(12),
          {
            label: 'Label size',
            description: 'Font size for graticule coordinate labels',
            group: 'layers',
            filter: ['global', 'graticule'],
            order: 5,
            control: 'slider',
            min: 8, max: 24, step: 1,
          },
        ),
        lineWidth: opt(
          z.number().min(1).max(5).default(1.5),
          {
            label: 'Line width',
            description: 'Width of graticule lines in pixels',
            group: 'layers',
            filter: ['global', 'graticule'],
            order: 6,
            control: 'slider',
            min: 1, max: 5, step: 0.5,
          },
        ),
      }),
    }),

    cities: z.object({
      opacity: opt(
        z.number().min(0.05).max(1).default(0.8),
        {
          label: 'City label opacity',
          description: 'Transparency of city labels',
          group: 'layers',
          filter: ['global', 'cities'],
          order: 3.6,
          control: 'slider',
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({
        // Persisted as RGB triplet; chip click in dialog maps named-color
        // value (`'white'`, etc.) → triplet via host's CITY_COLORS_RGB.
        color: opt(
          z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
          {
            label: 'Label color',
            description: 'Color of city labels and indicators',
            group: 'layers',
            filter: ['global', 'cities'],
            order: 3.7,
            control: 'color-chips',
            options: [
              { value: 'white',   label: 'White',    color: '#ffffff' },
              { value: 'black',   label: 'Black',    color: '#000000' },
              { value: 'darkred', label: 'Dark Red', color: '#8c0d0d' },
              { value: 'gold',    label: 'Gold',     color: '#d9a621' },
            ],
          },
        ),
      }),
    }),

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
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({}).default({}),
    }),

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
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({
        animated: opt(
          z.boolean().default(true),
          {
            label: 'Animate particles',
            description: 'Animate precipitation particles',
            group: 'layers',
            filter: 'rain',
            order: 12,
            control: 'toggle',
          },
        ),
      }),
    }),

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
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({}).default({}),
    }),

    wind: z.object({
      opacity: opt(
        z.number().min(0.05).max(1).default(0.8),
        {
          label: 'Wind opacity',
          description: 'Transparency of wind lines',
          group: 'layers',
          filter: ['global', 'wind'],
          order: 15,
          control: 'slider',
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({
        // Hidden in dialog until F-B (host's `wind.seedCount` is the visible
        // row; aurora's entry exists so aurora-db carries the shape).
        seedCount: opt(
          z.union([
            z.literal(8192), z.literal(16384), z.literal(32768),
            z.literal(49152), z.literal(65536),
          ]).default(8192),
          {
            label: 'Wind line count',
            description: 'Number of animated wind lines (affects performance)',
            group: 'layers',
            filter: ['global', 'wind'],
            order: 14,
            control: 'radio',
            options: [
              { value: 8192,  label: '8K' },
              { value: 16384, label: '16K' },
              { value: 32768, label: '32K' },
              { value: 49152, label: '48K' },
              { value: 65536, label: '64K' },
            ],
            hidden: true,
          },
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
              { value: 0,  label: 'Frozen', localhostOnly: true },
              { value: 15, label: '15' },
              { value: 30, label: '30' },
              { value: 60, label: '60' },
            ],
          },
        ),
      }),
    }),

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
          min: 0.05, max: 1, step: 0.05,
        },
      ),
      opts: z.object({
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
              { value: 'none',  label: 'None' },
              { value: 'light', label: 'Light' },
            ],
          },
        ),
        spacing: opt(
          z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(4),
          {
            label: 'Isobar spacing',
            description: 'Pressure difference between contour lines (hPa)',
            group: 'layers',
            filter: ['global', 'pressure'],
            order: 19,
            control: 'radio',
            options: [
              { value: 4,  label: '4 hPa' },
              { value: 6,  label: '6 hPa' },
              { value: 8,  label: '8 hPa' },
              { value: 10, label: '10 hPa' },
            ],
          },
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
          },
        ),
      }),
    }),
  }),
});

// ============================================================
// Derived types and helpers
// ============================================================

export type AuroraOptionsBlob = z.infer<typeof auroraOptionsSchema>;

/** Defaults blob, materialized once at module load. Used by adapters
 *  for the dialog's "reset to default" button and as the fallback for
 *  `defaults < seeds < persisted` merge in aurora-db init.
 *
 *  Seeded with empty placeholder objects at every nested wrapper so Zod
 *  cascades leaf `.default()` calls all the way down. Adding `.default({})`
 *  to each wrapper would work too but bloats the schema; one explicit
 *  parse-input here is the cleaner trade. */
export const auroraDefaults: AuroraOptionsBlob = auroraOptionsSchema.parse({
  engine: {},
  layers: {
    earth: {}, sun: {}, temp: {}, clouds: {},
    graticule: { opts: {} },
    cities:    { opts: {} },
    rain:      { opts: {} },
    wind:      { opts: {} },
    pressure:  { opts: {} },
  },
});
