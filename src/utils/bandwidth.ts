/**
 * Bandwidth calculation utilities
 */

export type Sample = { timestamp: number; bytes: number };

/**
 * Calculate bytes/sec from time-windowed samples
 * Requires at least 2 samples and 0.5s duration for stable measurement
 */
export function calcBandwidth(samples: Sample[], windowMs = 10000): number | undefined {
  const cutoff = performance.now() - windowMs;
  const recent = samples.filter(s => s.timestamp >= cutoff);
  if (recent.length < 2) return undefined;
  const duration = (performance.now() - recent[0]!.timestamp) / 1000;
  if (duration < 0.5) return undefined;
  return recent.reduce((sum, s) => sum + s.bytes, 0) / duration;
}

/**
 * Calculate ETA from remaining bytes and rate
 */
export function calcEta(bytesRemaining: number, bytesPerSec?: number): number | undefined {
  return bytesPerSec ? bytesRemaining / bytesPerSec : undefined;
}

/**
 * Prune samples older than windowMs
 */
export function pruneSamples(samples: Sample[], windowMs = 10000): Sample[] {
  const cutoff = performance.now() - windowMs;
  return samples.filter(s => s.timestamp >= cutoff);
}
