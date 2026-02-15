/**
 * QueueStatsTracker - Bandwidth measurement and download progress
 *
 * Tracks download progress, calculates bandwidth and ETA,
 * learns compression ratios for better estimates.
 */

import { signal } from '@preact/signals-core';
import type { QueueStats, QueueTask } from '../../config/types';
import { calcBandwidth, calcEta, pruneSamples, type Sample } from '../../utils/bandwidth';

const DEBUG = false;

/** Format stats for logging */
const formatStats = (s: QueueStats) =>
  `${(s.bytesQueued / 1024 / 1024).toFixed(1)}MB queued, ` +
  `${s.bytesPerSec ? (s.bytesPerSec / 1024 / 1024).toFixed(1) : '?'}MB/s, ` +
  `ETA ${s.etaSeconds?.toFixed(0) ?? '?'}s`;

export class QueueStatsTracker {
  readonly stats = signal<QueueStats>({
    bytesQueued: 0,
    bytesCompleted: 0,
    bytesPerSec: undefined,
    etaSeconds: undefined,
    status: 'idle',
  });

  // Bandwidth measurement
  private samples: Sample[] = [];

  // Compression ratio learning (rolling average)
  private compressionRatio = 1.0;
  private compressionSamples = 0;

  // Active download tracking (old path)
  pendingExpectedBytes = 0;
  activeExpectedBytes = 0;
  activeActualBytes = 0;
  private totalBytesCompleted = 0;

  // Batch stats (reset when new orders arrive after idle)
  private batchStartTime = 0;
  private batchBytesCompleted = 0;

  /** Called for each chunk received */
  onChunk(bytes: number): void {
    this.activeActualBytes += bytes;
    this.totalBytesCompleted += bytes;
    this.batchBytesCompleted += bytes;
    if (this.batchStartTime === 0) {
      this.batchStartTime = performance.now();
    }
    this.samples.push({ timestamp: performance.now(), bytes });
    this.samples = pruneSamples(this.samples);
  }

  /** Learn compression ratio from completed download */
  learnCompressionRatio(expectedBytes: number, actualBytes: number): void {
    if (expectedBytes === 0) return;
    const ratio = actualBytes / expectedBytes;
    this.compressionSamples++;
    this.compressionRatio += (ratio - this.compressionRatio) / this.compressionSamples;
  }

  /** Update stats signal with current queue state */
  update(
    taskQueue: QueueTask[],
    inFlightCount: number,
    inFlightBytes: number,
    onBatchComplete?: () => void
  ): void {
    const bytesPerSec = calcBandwidth(this.samples);

    // Estimate remaining bytes from old path (submitTimestepOrders)
    const oldPathPending = this.pendingExpectedBytes * this.compressionRatio;
    const oldPathActive = (this.activeExpectedBytes * this.compressionRatio) - this.activeActualBytes;

    // Estimate remaining bytes from reactive path (taskQueue + inFlight)
    const queuedBytes = taskQueue.reduce((sum, t) => sum + (t.sizeEstimate || 0), 0);
    const reactivePathPending = (queuedBytes + inFlightBytes) * this.compressionRatio;

    // Use reactive path if any reactive work pending
    const useReactivePath = inFlightCount > 0 || taskQueue.length > 0;
    const bytesQueued = useReactivePath
      ? Math.max(0, oldPathPending + reactivePathPending)
      : Math.max(0, oldPathPending + oldPathActive);

    const wasDownloading = this.stats.value.status === 'downloading';
    const newStatus = bytesQueued > 0 ? 'downloading' : 'idle';

    this.stats.value = {
      bytesQueued,
      bytesCompleted: this.totalBytesCompleted,
      bytesPerSec,
      etaSeconds: calcEta(bytesQueued, bytesPerSec),
      status: newStatus,
    };

    // Batch complete - log summary and reset
    if (wasDownloading && newStatus === 'idle') {
      if (this.batchBytesCompleted > 100 * 1024) {
        const elapsed = (performance.now() - this.batchStartTime) / 1000;
        const mb = this.batchBytesCompleted / (1024 * 1024);
        const speed = elapsed > 0 ? mb / elapsed : 0;
        console.log(`[Queue] Done: ${mb.toFixed(1)} MB in ${elapsed.toFixed(1)}s (${speed.toFixed(1)} MB/s)`);
      }
      this.batchStartTime = 0;
      this.batchBytesCompleted = 0;
      onBatchComplete?.();
    }

    DEBUG && console.log('[Queue]', formatStats(this.stats.value));
  }

  /** Reset active download state after file complete */
  resetActiveDownload(): void {
    this.learnCompressionRatio(this.activeExpectedBytes, this.activeActualBytes);
    this.activeExpectedBytes = 0;
    this.activeActualBytes = 0;
  }

  /** Full reset (for clearAllPending) */
  reset(): void {
    this.samples = [];
    this.compressionRatio = 1.0;
    this.compressionSamples = 0;
    this.pendingExpectedBytes = 0;
    this.activeExpectedBytes = 0;
    this.activeActualBytes = 0;
    this.totalBytesCompleted = 0;
    this.batchStartTime = 0;
    this.batchBytesCompleted = 0;
    this.stats.value = {
      bytesQueued: 0,
      bytesCompleted: 0,
      bytesPerSec: undefined,
      etaSeconds: undefined,
      status: 'idle',
    };
  }
}
