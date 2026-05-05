/**
 * Aurora-side option descriptors — engine-wide and per-built-in-layer.
 *
 * Authored without `scope`/`layerId`; stamped by `getEngineOptionsCatalog()`
 * and the layer-catalog walker (see `./catalog.ts`).
 *
 * Field shapes match what aurora actually persists today (the host's
 * pre-translated form: cities color is RGB triplet; pressure spacing is
 * already a number; etc.). The aurora-canonical names in
 * `aurora/types/options.ts` (particleCount, isobarSpacing, …) diverge —
 * Phase 9 cleanup reconciles them.
 */

import type { OptionDescriptorAuthor } from '../types/options-descriptor';
import type { PressureColorOption } from '../../schemas/options.schema';

/** Aurora-internal pressure-colors default. Duplicated from host's
 *  PRESSURE_COLOR_DEFAULT to satisfy Phase A acceptance ("no host imports
 *  for any aurora default value"); the *type* still imports from schemas
 *  until Phase G moves it. */
const PRESSURE_COLORS_DEFAULT: PressureColorOption = {
  mode: 'solid',
  colors: [[1, 1, 1, 0.85]],
};

// ─── Engine ──────────────────────────────────────────────────────────────────

export const ENGINE_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  {
    key: 'timeslotsPerLayer',
    kind: 'integer',
    default: 4,
    enum: [
      { value: 2 }, { value: 3 }, { value: 4 }, { value: 8 }, { value: 16 },
      { value: 32 }, { value: 64 }, { value: 128 }, { value: 256 }, { value: 512 },
    ],
    impact: 'reload',
  },
  {
    key: 'useTimestampQueries',
    kind: 'boolean',
    default: false,
    impact: 'reload',
  },
  {
    key: 'showLogo',
    kind: 'boolean',
    default: true,
    impact: 'live',
  },
];

// ─── Per-layer ──────────────────────────────────────────────────────────────

export const GRATICULE_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  { key: 'fontSize',  kind: 'number', default: 12,  min: 8, max: 24, step: 1, unit: 'px' },
  { key: 'lineWidth', kind: 'number', default: 1.5, min: 1, max: 5,  step: 0.5, unit: 'px' },
];

export const CITIES_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  { key: 'color', kind: 'rgb', default: [1, 1, 1] as [number, number, number] },
];

export const WIND_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  {
    key: 'seedCount',
    kind: 'integer',
    default: 8192,
    enum: [
      { value: 8192 }, { value: 16384 }, { value: 32768 },
      { value: 49152 }, { value: 65536 },
    ],
    impact: 'recreate',
  },
  {
    key: 'speed',
    kind: 'integer',
    default: 30,
    enum: [{ value: 0 }, { value: 15 }, { value: 30 }, { value: 60 }],
  },
];

export const PRESSURE_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  {
    key: 'spacing',
    kind: 'integer',
    default: 4,
    unit: 'hPa',
    enum: [{ value: 4 }, { value: 6 }, { value: 8 }, { value: 10 }],
  },
  {
    key: 'smoothing',
    kind: 'enum',
    default: 'light',
    enum: [{ value: 'none' }, { value: 'light' }],
  },
  {
    key: 'colors',
    kind: 'pressureColors',
    default: PRESSURE_COLORS_DEFAULT,
  },
];

export const RAIN_OPTION_DESCRIPTORS: OptionDescriptorAuthor[] = [
  { key: 'animated', kind: 'boolean', default: true },
];
