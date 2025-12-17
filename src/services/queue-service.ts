/**
 * QueueService - Download queue with progress tracking
 *
 * Fetches files sequentially with streaming chunks for accurate ETA.
 * Learns compression ratio from completed files for better estimates.
 * Single source of truth for all pending downloads.
 */

import { signal } from '@preact/signals-core';
import type { FileOrder, QueueStats, IQueueService, TimestepOrder, OmSlice, TParam, TTimestep } from '../config/types';
import { fetchStreaming } from '../utils/fetch';
import type { OmService } from './om-service';
import type { OptionsService } from './options-service';

export type LoadingStrategy = 'alternate' | 'future-first';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: string) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TParam) => param.slice(0, 4).toUpperCase();

/** Default estimated size for unknown timesteps (~8MB for 10 slices) */
const DEFAULT_SIZE_ESTIMATE = 8.0 * 1024 * 1024;

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
  private currentAbortController: AbortController | null = null;
  private processingPromise: Promise<void> | null = null;

  private omService: OmService | null = null;
  private optionsService: OptionsService | null = null;

  /** Set OmService (injected later to avoid circular deps) */
  setOmService(omService: OmService): void {
    this.omService = omService;
  }

  /** Set OptionsService for strategy access */
  setOptionsService(optionsService: OptionsService): void {
    this.optionsService = optionsService;
  }

  async submitFileOrders(
    orders: FileOrder[],
    onProgress?: (index: number, total: number) => void | Promise<void>
  ): Promise<ArrayBuffer[]> {
    DEBUG && console.log(`[Queue] ${orders.length} fileorders`);

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

    // Check if current fetch should be aborted (not in new orders)
    if (this.currentlyFetching && this.currentAbortController) {
      const keepCurrent = orders.some(o => o.timestep === this.currentlyFetching!.timestep);
      if (!keepCurrent) {
        console.log(`[Queue] Aborting: ${this.currentlyFetching.timestep.slice(5, 13)}`);
        this.currentAbortController.abort();
      }
    }

    // Filter out the currently fetching order (if in new orders)
    const newOrders = this.currentlyFetching
      ? orders.filter(o => o.timestep !== this.currentlyFetching!.timestep)
      : orders;

    // Get param(s) being submitted - keep other params' pending orders
    const submittedParams = new Set(newOrders.map(o => o.param));
    const keepFromExisting = this.timestepQueue.filter(q => !submittedParams.has(q.order.param));

    // Build queue: keep other params + new orders for this param
    this.timestepQueue = [
      ...keepFromExisting,
      ...newOrders.map(order => {
      const estimatedBytes = isNaN(order.sizeEstimate) ? DEFAULT_SIZE_ESTIMATE : order.sizeEstimate;
      return {
        order,
        estimatedBytes,
        onSlice,
        onPreflight: (actualBytes: number) => {
          // Transfer from pending to active tracking
          this.pendingExpectedBytes -= estimatedBytes;
          this.activeExpectedBytes = actualBytes;
          this.activeActualBytes = 0;
          this.updateStats();
          onPreflight?.(order, actualBytes);
        },
      };
    }),
    ];

    // Sort queue by strategy (priority timesteps first, then by strategy)
    this.sortQueueByStrategy();

    // Calculate pending bytes from estimates (instant)
    this.pendingExpectedBytes = this.timestepQueue.reduce((sum, q) => sum + q.estimatedBytes, 0);
    this.updateStats();

    // Log one line per param (grouped, in order of first appearance)
    const byParam = new Map<TParam, TimestepOrder[]>();
    for (const order of orders) {
      const list = byParam.get(order.param) || [];
      list.push(order);
      byParam.set(order.param, list);
    }
    for (const [param, paramOrders] of byParam) {
      const first = fmt(paramOrders[0]!.timestep);
      const last = fmt(paramOrders[paramOrders.length - 1]!.timestep);
      console.log(`[Queue] ${P(param)} ${paramOrders.length} TS, ${first} -> ${last}`);
    }

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
      this.currentAbortController = new AbortController();

      // Map TParam to Open-Meteo parameter names
      const paramMap: Record<string, string> = {
        temp: 'temperature_2m',
        pressure: 'pressure_msl',
      };
      const omParam = paramMap[next.order.param] ?? next.order.param;

      try {
        await this.omService!.fetch(
          next.order.url,
          omParam,
          (info) => {
            // Preflight done - report actual size for ETA correction
            next.onPreflight(info.totalBytes);
          },
          (slice) => next.onSlice(next.order, slice),
          (bytes) => {
            this.onChunk(bytes);
          },
          this.currentAbortController.signal
        );
      } catch (err) {
        // Ignore abort errors, rethrow others
        if (err instanceof Error && err.name === 'AbortError') {
          console.log(`[Queue] Aborted: ${next.order.timestep.slice(5, 13)}`);
        } else {
          throw err;
        }
      }

      // Reset active tracking
      this.activeExpectedBytes = 0;
      this.activeActualBytes = 0;
      this.currentlyFetching = null;
      this.currentAbortController = null;
    }

    this.processingPromise = null;
    this.updateStats();
  }

  private async fetchWithProgress(order: FileOrder): Promise<ArrayBuffer> {
    // Start tracking this file
    this.pendingExpectedBytes -= order.size;
    this.activeExpectedBytes = order.size;
    this.activeActualBytes = 0;

    const buffer = await fetchStreaming(
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

    // Update stats signal (no cycle risk: SlotService uses queueMicrotask for fetching)
    const wasDownloading = this.stats.value.status === 'downloading';
    const newStatus = bytesQueued > 0 ? 'downloading' : 'idle';
    this.stats.value = {
      bytesQueued,
      bytesCompleted: this.totalBytesCompleted,
      bytesPerSec,
      etaSeconds: bytesPerSec ? bytesQueued / bytesPerSec : undefined,
      status: newStatus,
    };
    if (wasDownloading && newStatus === 'idle') {
      console.log('[Queue] Done');
    }
    DEBUG && console.log('[Queue]', formatStats(this.stats.value));
  }

  /**
   * Sort queue by loading strategy.
   * Priority: timesteps closest to current time come first (across all params).
   * Then rest sorted by strategy (alternate: interleave future/past, future-first: all future then past).
   */
  private sortQueueByStrategy(): void {
    if (!this.optionsService || this.timestepQueue.length <= 1) return;

    const currentTime = this.optionsService.options.value.viewState.time;
    const strategy = this.optionsService.options.value.dataCache.cacheStrategy as LoadingStrategy;

    // Parse timestep to Date for comparison
    const toDate = (ts: TTimestep): Date => {
      // Format: "2025-12-19T0400" -> "2025-12-19T04:00:00Z"
      const formatted = ts.slice(0, 11) + ts.slice(11, 13) + ':00:00Z';
      return new Date(formatted);
    };

    // Sort by distance from current time, with strategy for ties
    this.timestepQueue.sort((a, b) => {
      const tsA = toDate(a.order.timestep);
      const tsB = toDate(b.order.timestep);
      const distA = Math.abs(tsA.getTime() - currentTime.getTime());
      const distB = Math.abs(tsB.getTime() - currentTime.getTime());

      // Primary: closest to current time first
      if (distA !== distB) return distA - distB;

      // Secondary: by strategy
      const isFutureA = tsA.getTime() >= currentTime.getTime();
      const isFutureB = tsB.getTime() >= currentTime.getTime();

      if (strategy === 'future-first') {
        // Future before past
        if (isFutureA !== isFutureB) return isFutureA ? -1 : 1;
      }
      // 'alternate' or same future/past status: maintain relative order
      return 0;
    });
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
