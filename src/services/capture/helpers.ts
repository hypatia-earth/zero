/**
 * Pure helper functions for capture math and formatting.
 * No dependencies — just numbers and strings.
 */

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── Time / frame mapping ─────────────────────────────────────

/** Map a timestamp to 0–100 percent position within [start, end] */
export function timeToPercent(time: number, start: number, end: number): number {
  const range = end - start;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(100, ((time - start) / range) * 100));
}

/** Map a timestamp to a video frame number within [start, end] */
export function timeToFrame(timeMs: number, startMs: number, endMs: number, totalFrames: number): number {
  const range = endMs - startMs;
  if (range <= 0) return 0;
  const elapsed = Math.max(0, timeMs - startMs);
  return Math.min(Math.round((elapsed / range) * totalFrames), totalFrames);
}

/**
 * Create a mapper from video frame index to weather timestamp (minute-stepped).
 * Captures keyframe range constants, returns per-frame function.
 */
export function createFrameTimeMapper(startTime: number, endTime: number, totalFrames: number): (frame: number) => number {
  const totalMinutes = (endTime - startTime) / 60_000;
  if (totalMinutes <= 0) return () => startTime;
  const framesPerMinute = totalFrames / totalMinutes;
  return (frame: number) => startTime + Math.floor(frame / framesPerMinute) * 60_000;
}

// ── SMPTE timecode ───────────────────────────────────────────

/** Convert a frame number to SMPTE timecode HH:MM:SS:FF */
export function frameToSMPTE(frame: number, fps: number): string {
  const totalSec = Math.floor(frame / fps);
  return `${pad2(Math.floor(totalSec / 3600))}:${pad2(Math.floor(totalSec / 60) % 60)}:${pad2(totalSec % 60)}:${pad2(frame % fps)}`;
}

// ── Date formatting ──────────────────────────────────────────

/** "YYYY-MM-DD HH:MM UTC" — for display and metadata timestamps */
export function formatTimestampUTC(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** "YYYYMMDDHHmmUTC" — for export filenames */
export function formatDateFilename(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}UTC`;
}

/** "MM-DD:HH:mm" — for compact console logging */
export function formatDateCompact(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}:${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "HH:MM" — for time labels on capture bar */
export function formatTimeHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// ── Pixel math ───────────────────────────────────────────────

/** Snap to nearest even number (H.264 requires even dimensions) */
export function snapEven(n: number): number {
  return n & ~1;
}

// ── File size ────────────────────────────────────────────────

/** Format byte count as human-readable size */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}
