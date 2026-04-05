/**
 * AdaptiveConcurrency - Adjusts concurrent slow download limit based on throughput.
 *
 * Starts at min, probes +1 after stable measurement. Keeps if aggregate
 * throughput improved beyond a dynamic threshold (scales with 1/N — higher
 * concurrency needs less relative improvement). Backs off on failure but
 * retries on next measurement cycle. Resets when queue goes idle.
 *
 * Tracks its own chunk samples per level — no carryover from previous levels.
 * Decisions use median of bandwidth readings to reduce snapshot noise.
 */

import { effect } from '@preact/signals-core';
import { calcBandwidth, pruneSamples, type Sample } from '../../utils/bandwidth';
import type { OptionsService } from '../options-service';

const SAMPLES_BEFORE_PROBE = 3;
const WARMUP_DISCARD = 2;
/** Expect at least half the theoretical gain (1/N) to keep probing */
const THRESHOLD_FRACTION = 0.5;
const BANDWIDTH_WINDOW_MS = 5000;

export class AdaptiveConcurrency {
  private maxSlow: number;
  private min: number;
  private max: number;
  private prevBandwidth = 0;
  private probeState: 'measuring' | 'probing' = 'measuring';
  private samplesAtLevel = 0;
  private warmupRemaining = 0;
  private levelSamples: Sample[] = [];
  private readings: number[] = [];
  private disposeEffect: () => void;

  constructor(optionsService: OptionsService) {
    const gpu = optionsService.options.value.gpu;
    this.min = gpu.minDownloads;
    this.max = gpu.maxDownloads;
    this.maxSlow = this.min;

    this.disposeEffect = effect(() => {
      const gpu = optionsService.options.value.gpu;
      this.min = gpu.minDownloads;
      this.max = gpu.maxDownloads;
      this.maxSlow = Math.max(this.min, Math.min(this.maxSlow, this.max));
    });
  }

  getMaxSlow(): number {
    return this.maxSlow;
  }

  /** Feed chunk bytes as they arrive from any slow connection */
  onChunk(bytes: number): void {
    this.levelSamples.push({ timestamp: performance.now(), bytes });
    this.levelSamples = pruneSamples(this.levelSamples, BANDWIDTH_WINDOW_MS);
  }

  /** Call when a slow (network) task completes */
  onSlowTaskComplete(): void {
    if (this.warmupRemaining > 0) {
      this.warmupRemaining--;
      if (this.warmupRemaining === 0) this.levelSamples = [];
      return;
    }

    const bytesPerSec = calcBandwidth(this.levelSamples, BANDWIDTH_WINDOW_MS);
    if (isNaN(bytesPerSec)) return;

    this.readings.push(bytesPerSec);
    this.samplesAtLevel++;

    if (this.samplesAtLevel < SAMPLES_BEFORE_PROBE) return;

    const median = medianOf(this.readings);

    if (this.probeState === 'measuring') {
      if (this.maxSlow >= this.max) return;
      this.prevBandwidth = median;
      this.maxSlow++;
      this.probeState = 'probing';
      this.resetLevel();
    } else {
      const threshold = 1 + THRESHOLD_FRACTION / this.maxSlow;
      if (median > this.prevBandwidth * threshold) {
        this.probeState = 'measuring';
        this.resetLevel();
      } else {
        this.maxSlow--;
        this.probeState = 'measuring';
        this.resetLevel();
      }
    }
  }

  private resetLevel(): void {
    this.samplesAtLevel = 0;
    this.warmupRemaining = WARMUP_DISCARD;
    this.levelSamples = [];
    this.readings = [];
  }

  /** Reset to initial state — call when queue goes idle */
  reset(): void {
    if (this.maxSlow > this.min) {
      console.log(`[Adaptive] reset (${this.maxSlow}/${this.max})`);
    }
    this.maxSlow = this.min;
    this.prevBandwidth = 0;
    this.probeState = 'measuring';
    this.samplesAtLevel = 0;
    this.warmupRemaining = 0;
    this.levelSamples = [];
    this.readings = [];
  }

  dispose(): void {
    this.disposeEffect();
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

