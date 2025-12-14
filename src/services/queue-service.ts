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

/** Default estimated size for unknown timesteps (~1.5MB compressed typical) */
const DEFAULT_SIZE_ESTIMATE = 1.5 * 1024 * 1024;

/** Queued order with callback */
interface QueuedTimestepOrder {
  order: TimestepOrder;
  estimatedBytes: number;
  onSlice: (order: TimestepOrder, slice: OmSlice) => void;
  onPreflight: (actualBytes: number) => void;
}

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

  // Timestep queue (replaceable)
  private timestepQueue: QueuedTimestepOrder[] = [];
  private currentlyFetching: TimestepOrder | null = null;
  private processingPromise: Promise<void> | null = null;

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
   * Replaces any pending orders with new ones (current fetch continues)
   * Orders are processed in array order (caller should sort by priority)
   * No batched preflight - uses size estimates for instant queue start
   */
  async submitTimestepOrders(
    orders: TimestepOrder[],
    onSlice: (order: TimestepOrder, slice: OmSlice) => void,
    onPreflight?: (order: TimestepOrder, actualBytes: number) => void
  ): Promise<void> {
    if (!this.omService) {
      throw new Error('OmService not set - call setOmService first');
    }

    if (orders.length === 0) return;

    // Filter out the currently fetching order (if in new orders)
    const newOrders = this.currentlyFetching
      ? orders.filter(o => o.timestep !== this.currentlyFetching!.timestep)
      : orders;

    // Build queue with size estimates (instant, no async)
    this.timestepQueue = newOrders.map(order => {
      const estimatedBytes = isNaN(order.sizeEstimate) ? DEFAULT_SIZE_ESTIMATE : order.sizeEstimate;
      return {
        order,
        estimatedBytes,
        onSlice,
        onPreflight: (actualBytes: number) => {
          // Adjust pending bytes when actual size known
          const delta = actualBytes - estimatedBytes;
          this.pendingExpectedBytes += delta;
          this.updateStats();
          onPreflight?.(order, actualBytes);
        },
      };
    });

    // Calculate pending bytes from estimates (instant)
    this.pendingExpectedBytes = this.timestepQueue.reduce((sum, q) => sum + q.estimatedBytes, 0);
    this.updateStats();

    const dropped = orders.length - newOrders.length;
    DEBUG && console.log(`[Queue] New queue: ${newOrders.length} orders, ${(this.pendingExpectedBytes / 1024 / 1024).toFixed(1)} MB (est)` +
      (dropped ? ` (${dropped} already fetching)` : ''));

    // Start processing if not already running
    if (!this.processingPromise) {
      this.processingPromise = this.processTimestepQueue();
    }

    // Return promise for callers that need to wait (e.g., initialize)
    return this.processingPromise;
  }

  /** Process timestep queue sequentially */
  private async processTimestepQueue(): Promise<void> {
    while (this.timestepQueue.length > 0) {
      const next = this.timestepQueue.shift()!;
      this.currentlyFetching = next.order;

      const omParam = next.order.param === 'temp' ? 'temperature_2m' : next.order.param;

      await this.omService!.fetch(
        next.order.url,
        omParam,
        (info) => {
          // Preflight done - report actual size for ETA correction
          next.onPreflight(info.totalBytes);
        },
        (slice) => next.onSlice(next.order, slice),
        (bytes) => {
          this.pendingExpectedBytes -= bytes;
          this.onChunk(bytes);
        }
      );

      this.currentlyFetching = null;
    }

    this.processingPromise = null;
    this.updateStats();
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
