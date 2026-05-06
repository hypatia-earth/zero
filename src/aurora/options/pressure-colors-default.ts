/**
 * Pressure-colors runtime default — split out of `./schema.ts` so worker
 * code (globe-renderer, pressure-aurora-layer) can import the const value
 * without pulling Zod into the worker bundle.
 *
 * Type lives next to the schema; this file re-exports it as a type-only
 * convenience (type imports erase at compile time).
 */

export type { PressureColorOption } from './schema';

import type { PressureColorOption } from './schema';

export const PRESSURE_COLOR_DEFAULT: PressureColorOption = {
  mode: 'solid',
  colors: [[1, 1, 1, 0.85]],
};
