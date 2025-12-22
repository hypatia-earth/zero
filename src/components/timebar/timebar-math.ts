/**
 * Timebar math utilities
 * Pure functions for disk warp positioning and sun brightness
 */

import { getSunDirection } from '../../utils/sun-position';

/** Disk perspective warp - compresses edges, expands center */
export function diskWarp(t: number): number {
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/** Inverse of diskWarp - converts screen position to linear time */
export function diskUnwarp(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return Math.acos(1 - 2 * clamped) / Math.PI;
}

/** Disk height factor - taller in center, shorter at edges */
const DISK_MIN_HEIGHT = 0.5;
export function diskHeight(t: number): number {
  return DISK_MIN_HEIGHT + (1 - DISK_MIN_HEIGHT) * Math.sin(t * Math.PI);
}

/**
 * Calculate sun brightness for a point on globe at given time
 * Returns 0.5 (night) to 1.0 (day)
 */
export function getSunBrightness(lat: number, lon: number, time: Date): number {
  const sunDir = getSunDirection(time);
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const lookAt = [
    Math.cos(latRad) * Math.sin(lonRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.cos(lonRad),
  ];
  const sunDot = sunDir[0]! * lookAt[0]! + sunDir[1]! * lookAt[1]! + sunDir[2]! * lookAt[2]!;
  return 0.75 + sunDot * 0.25;
}
