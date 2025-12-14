/**
 * QueueService - Download queue with progress tracking
 *
 * Fetches files sequentially with streaming chunks for accurate ETA.
 * Learns compression ratio from completed files for better estimates.
 * Single source of truth for all pending downloads.
 */

import { signal } from '@preact/signals-core';
import type { FileOrder, QueueStats, IQueueService, TimestepOrder, OmSlice } from '../config/types';
import type { FetchService } from './fetch-service';
import type { OmService } from './om-service';

const DEBUG = true;

export class QueueService implements IQueueService {
  readonly stats = signal<QueueStats>({
    bytesQueued: 0,
    bytesCompleted: 0,
    bytesPerSec: undefined,
    etaSeconds: undefined,
    status: 'idle',
  });

  // Bandwidth measurement
  private samples: Array<{ timestamp: number; bytes: number }> = [];

  // Compression ratio learning (rolling average)
  private compressionRatio = 1.0;
  private compressionSamples = 0;

  // Active download tracking
  private pendingExpectedBytes = 0;
  private activeExpectedBytes = 0;
  private activeActualBytes = 0;
  private totalBytesCompleted = 0;

  private omService: OmService | null = null;

  constructor(private fetchService: FetchService) {}

  /** Set OmService (injected later to avoid circular deps) */
  setOmService(omService: OmService): void {
    this.omService = omService;
  }

  async submitFileOrders(
    orders: FileOrder[],
    onProgress?: (index: number, total: number) => void | Promise<void>
  ): Promise<ArrayBuffer[]> {
    // Sum expected bytes for all orders
    for (const order of orders) {
      this.pendingExpectedBytes += order.size;
    }
    this.updateStats();

    // Fetch sequentially
    const results: ArrayBuffer[] = [];
    let i = 0;
    for (const order of orders) {
      await onProgress?.(i++, orders.length);
      const buffer = await this.fetchWithProgress(order);
      results.push(buffer);
    }

    this.updateStats();
    return results;
  }

  /**
   * Submit timestep orders for processing via OmService
   * @param orders Timestep orders to fetch
   * @param onSlice Callback for each decoded slice (GPU-ready data)
   */
  async submitTimestepOrders(
    orders: TimestepOrder[],
    onSlice: (order: TimestepOrder, slice: OmSlice) => void
  ): Promise<void> {
    if (!this.omService) {
      throw new Error('OmService not set - call setOmService first');
    }

    // Process sequentially
    for (const order of orders) {
      const omParam = order.param === 'temp' ? 'temperature_2m' : order.param;

      await this.omService.fetch(
        order.url,
        omParam,
        // Preflight: update stats with exact size
        (info) => {
          this.pendingExpectedBytes += info.totalBytes;
          this.updateStats();
        },
        // Slice: report progress and forward to caller
        (slice) => {
          // Track bytes (approximate from slice progress)
          // TODO: More accurate tracking from actual fetch bytes
          onSlice(order, slice);
        }
      );

      // Order complete
      this.updateStats();
    }
  }

  private async fetchWithProgress(order: FileOrder): Promise<ArrayBuffer> {
    // Start tracking this file
    this.pendingExpectedBytes -= order.size;
    this.activeExpectedBytes = order.size;
    this.activeActualBytes = 0;

    const buffer = await this.fetchService.fetch2(
      order.url,
      {},
      (bytes) => this.onChunk(bytes)
    );

    // File complete - learn compression ratio
    this.learnCompressionRatio(this.activeExpectedBytes, this.activeActualBytes);
    this.activeExpectedBytes = 0;
    this.activeActualBytes = 0;

    return buffer;
  }

  private onChunk(bytes: number): void {
    this.activeActualBytes += bytes;
    this.totalBytesCompleted += bytes;
    this.samples.push({ timestamp: performance.now(), bytes });
    this.pruneOldSamples();
    this.updateStats();
  }

  private learnCompressionRatio(expectedBytes: number, actualBytes: number): void {
    if (expectedBytes === 0) return;
    const ratio = actualBytes / expectedBytes;
    // Rolling average
    this.compressionSamples++;
    this.compressionRatio += (ratio - this.compressionRatio) / this.compressionSamples;
  }

  private pruneOldSamples(): void {
    const cutoff = performance.now() - 10_000; // 10s window
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
  }

  private updateStats(): void {
    // Bandwidth calculation
    let bytesPerSec: number | undefined;
    if (this.samples.length >= 2) {
      const first = this.samples[0]!;
      const duration = (performance.now() - first.timestamp) / 1000;
      if (duration >= 0.5) {
        const totalBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
        bytesPerSec = totalBytes / duration;
      }
    }

    // Estimate remaining bytes (apply compression ratio)
    const pendingWireBytes = this.pendingExpectedBytes * this.compressionRatio;
    const activeRemainingBytes = (this.activeExpectedBytes * this.compressionRatio) - this.activeActualBytes;
    const bytesQueued = Math.max(0, pendingWireBytes + activeRemainingBytes);

    // Update stats signal
    this.stats.value = {
      bytesQueued,
      bytesCompleted: this.totalBytesCompleted,
      bytesPerSec,
      etaSeconds: bytesPerSec ? bytesQueued / bytesPerSec : undefined,
      status: bytesQueued > 0 ? 'downloading' : 'idle',
    };
    DEBUG && console.log('[Queue]', formatStats(this.stats.value));
  }

  dispose(): void {
    this.samples = [];
    this.compressionRatio = 1.0;
    this.compressionSamples = 0;
    this.pendingExpectedBytes = 0;
    this.activeExpectedBytes = 0;
    this.activeActualBytes = 0;
    this.totalBytesCompleted = 0;
  }
}

function formatStats(s: QueueStats): string {
  const kb = (b: number) => (b / 1024).toFixed(0);
  const bps = s.bytesPerSec ? `${kb(s.bytesPerSec)}KB/s` : '?';
  const eta = s.etaSeconds !== undefined ? `${s.etaSeconds.toFixed(1)}s` : '?';
  return `Q:${kb(s.bytesQueued)}KB D:${kb(s.bytesCompleted)}KB ${bps} ${eta}`;
}
