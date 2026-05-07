/**
 * Sun position calculation
 */

export function getSunDirection(date: Date): Float32Array {
  // Simplified sun position calculation
  const dayOfYear = getDayOfYear(date);
  const hourUTC = date.getUTCHours() + date.getUTCMinutes() / 60;

  // Solar declination (approximate)
  const declination = -23.45 * Math.cos(2 * Math.PI * (dayOfYear + 10) / 365) * Math.PI / 180;

  // Hour angle (sun at noon = 0, moves 15 deg/hour westward)
  const hourAngle = (12 - hourUTC) * 15 * Math.PI / 180;

  // Convert to Cartesian (sun direction in world space)
  const x = Math.cos(declination) * Math.sin(hourAngle);
  const y = Math.sin(declination);
  const z = Math.cos(declination) * Math.cos(hourAngle);

  // Normalize
  const len = Math.sqrt(x * x + y * y + z * z);
  return new Float32Array([x / len, y / len, z / len]);
}

function getDayOfYear(date: Date): number {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}
