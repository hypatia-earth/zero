/**
 * Timestep format utilities
 *
 * TTimestep format: "YYYY-MM-DDTHHMM" (e.g., "2025-12-14T1100")
 */

import type { TTimestep } from '../config/types';

/** Convert TTimestep string to Date */
export function parseTimestep(ts: TTimestep): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})$/.exec(ts);
  if (!match) throw new Error(`Invalid timestep: ${ts}`);
  return new Date(Date.UTC(
    parseInt(match[1]!),
    parseInt(match[2]!) - 1,
    parseInt(match[3]!),
    parseInt(match[4]!),
    parseInt(match[5]!)
  ));
}

/** Convert Date to TTimestep string */
export function formatTimestep(date: Date): TTimestep {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}${min}` as TTimestep;
}

/** Parse timestep from .om filename (e.g., "2025-12-14T1100.om") */
export function parseFilenameTimestep(filename: string): Date {
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.om$/.exec(filename);
  if (!match) throw new Error(`Invalid timestep filename: ${filename}`);
  return new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
}
