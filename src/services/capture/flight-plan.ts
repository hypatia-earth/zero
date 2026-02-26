/**
 * Flight Plan parser/formatter
 *
 * Semicolon-separated format for keyframe definition:
 *   # wrap: true          → directive
 *   # comment             → ignored
 *   time; lat; lon; alt[; location]  → keyframe line
 *
 * Alt ↔ distance conversion (matching viewport.ts):
 *   distance = (alt + 6371) / 6371
 *   alt = (distance - 1) * 6371
 */

import type { CameraKeyframe } from './keyframe';

const EARTH_RADIUS_KM = 6371;

export interface FlightPlanResult {
  keyframes: { time: number; lat: number; lon: number; distance: number; location?: string }[];
  wrap: boolean;
}

function altToDistance(alt: number): number {
  return (alt + EARTH_RADIUS_KM) / EARTH_RADIUS_KM;
}

function distanceToAlt(distance: number): number {
  return (distance - 1) * EARTH_RADIUS_KM;
}

function padTime(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/**
 * Parse flight plan text into keyframes and directives.
 * Throws Error with descriptive message on invalid input.
 */
export function parseFlightPlan(text: string, windowStart: number, windowEnd: number): FlightPlanResult {
  let wrap = false;
  const keyframes: FlightPlanResult['keyframes'] = [];

  const lines = text.split('\n');
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const raw = lines[lineNum]!.trim();
    if (raw === '') continue;

    // Comment / directive lines
    if (raw.startsWith('#')) {
      const content = raw.slice(1).trim();
      // Directive: "key: value" (must have colon)
      const colonIdx = content.indexOf(':');
      if (colonIdx > 0) {
        const key = content.slice(0, colonIdx).trim().toLowerCase();
        const value = content.slice(colonIdx + 1).trim().toLowerCase();
        if (key === 'wrap') {
          wrap = value === 'true';
        }
        // Unknown directives silently ignored
      }
      // Comments (no colon, or column headers) — skip
      continue;
    }

    // Keyframe line: time; lat; lon; alt[; location]
    const parts = raw.split(';');
    if (parts.length < 4) {
      throw new Error(`Line ${lineNum + 1}: expected at least 4 fields (time; lat; lon; alt)`);
    }

    const timeStr = parts[0]!.trim();
    const latStr = parts[1]!.trim();
    const lonStr = parts[2]!.trim();
    const altStr = parts[3]!.trim();
    const location = parts.length > 4 ? parts.slice(4).join(';').trim() : undefined;

    // Parse time
    const date = new Date(timeStr + 'Z');
    if (isNaN(date.getTime())) {
      throw new Error(`Line ${lineNum + 1}: invalid date "${timeStr}"`);
    }
    const timeMs = date.getTime();

    if (timeMs < windowStart || timeMs > windowEnd) {
      throw new Error(`Line ${lineNum + 1}: time outside data window`);
    }

    // Parse lat
    const lat = parseFloat(latStr);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      throw new Error(`Line ${lineNum + 1}: invalid latitude "${latStr}"`);
    }

    // Parse lon
    const lon = parseFloat(lonStr);
    if (isNaN(lon) || lon < -180 || lon > 180) {
      throw new Error(`Line ${lineNum + 1}: invalid longitude "${lonStr}"`);
    }

    // Parse alt
    const alt = parseFloat(altStr);
    if (isNaN(alt) || alt < 0) {
      throw new Error(`Line ${lineNum + 1}: invalid altitude "${altStr}"`);
    }

    const entry: FlightPlanResult['keyframes'][number] = {
      time: timeMs,
      lat,
      lon,
      distance: altToDistance(alt),
    };
    if (location) entry.location = location;
    keyframes.push(entry);
  }

  if (keyframes.length < 2) {
    throw new Error('At least 2 keyframes required');
  }

  // Sort by time
  keyframes.sort((a, b) => a.time - b.time);

  return { keyframes, wrap };
}

/**
 * Format keyframes into flight plan text.
 */
export function formatFlightPlan(keyframes: CameraKeyframe[], wrap: boolean): string {
  const lines: string[] = [];

  if (wrap) {
    lines.push('# wrap: true');
  }
  lines.push('# time; lat; lon; alt');

  for (const kf of keyframes) {
    const time = padTime(new Date(kf.time));
    const lat = kf.lat.toFixed(1);
    const lon = kf.lon.toFixed(1);
    const alt = Math.round(distanceToAlt(kf.distance));
    lines.push(`${time}; ${lat.padStart(6)}; ${lon.padStart(7)}; ${alt}`);
  }

  return lines.join('\n');
}
