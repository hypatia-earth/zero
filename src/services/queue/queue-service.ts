/**
 * QueueService - Download queue with progress tracking
 *
 * Fetches files sequentially with streaming chunks for accurate ETA.
 * Learns compression ratio from completed files for better estimates.
 * Single source of truth for all pending downloads.
 */

import { computed, effect } from '@preact/signals-core';
import type { FileOrder, IQueueService, TimestepOrder, OmSlice, QueueTask } from '../../config/types';
import { isWeatherLayer } from '../../config/types';
import { fetchStreaming } from '../../utils/fetch';
import { sortByTimestep } from './sorter';
import { QueueStatsTracker } from './stats';
import type { OmService } from './om-service';
import type { OptionsService } from '../options-service';
import type { ConfigService } from '../config-service';
import type { StateService } from '../state-service';
import type { TimestepService } from '../timestep/timestep-service';
import type { LayerService } from '../layer/layer-service';
import type { ParamSlotService } from '../param-slot-service';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: string) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.slice(0, 4).toUpperCase();

/** Queued order with callback */
interface QueuedTimestepOrder {
  order: TimestepOrder;
  estimatedBytes: number;
  onSlice: (order: TimestepOrder, slice: OmSlice) => void | Promise<void>;
  onPreflight: (actualBytes: number) => void;
}

/** In-flight task with abort controller */
interface InFlightTask {
  task: QueueTask;
  abortController: AbortController;
}

export class QueueService implements IQueueService {
  // Stats tracking (bandwidth, ETA, compression learning)
  private readonly statsTracker = new QueueStatsTracker();
  readonly queueStats = this.statsTracker.stats;

  // Timestep queue (replaceable)
  private timestepQueue: QueuedTimestepOrder[] = [];
  private currentlyFetching: TimestepOrder | null = null;
  private currentAbortController: AbortController | null = null;
  private processingPromise: Promise<void> | null = null;

  // Reactive queue (Phase 3)
  private taskQueue: QueueTask[] = [];
  private inFlight: Map<string, InFlightTask> = new Map(); // key: `${param}:${timestep}:${slabIndex}`
  private slotService: ParamSlotService | null = null;
  private disposeEffect: (() => void) | null = null;

  /** Reactive parameters for queue management */
  readonly qsParams = computed(() => {
    const opts = this.optionsService.options.value;
    // Trigger recompute when layer registry changes
    this.layerService.changed.value;

    // Get all enabled layers with params
    const activeLayers = new Set<string>(
      this.layerService.getAll()
        .filter(l => l.params?.length && this.layerService.isLayerEnabled(l.id))
        .map(l => l.id)
    );

    return {
      time: this.stateService.viewState.value.time,
      poolSize: parseInt(opts.gpu.workerPoolSize, 10),
      numSlots: parseInt(opts.gpu.timeslotsPerLayer, 10),
      activeLayers: [...activeLayers],
      strategy: opts.dataCache.cacheStrategy,
    };
  });

  constructor(
    private omService: OmService,
    private optionsService: OptionsService,
    private stateService: StateService,
    private configService: ConfigService,
    private timestepService: TimestepService,
    private layerService: LayerService
  ) {}

  /** Set SlotService reference (avoids circular dependency) */
  setSlotService(ss: ParamSlotService): void {
    this.slotService = ss;
  }

  /** Initialize reactive queue management (skips first run - bootstrap already loaded priority) */
  initReactive(): void {
    let isFirstRun = true;
    let last = { time: '', pool: 0, slots: 0, layers: 0 };

    this.disposeEffect = effect(() => {
      const params = this.qsParams.value;
      const curr = {
        time: params.time.toISOString().slice(11, 16),
        pool: params.poolSize,
        slots: params.numSlots,
        layers: params.activeLayers.length,
      };

      // Build diff of what changed
      const changes: string[] = [];
      if (last.time !== curr.time) changes.push(`time=${last.time}→${curr.time}`);
      if (last.pool !== curr.pool) changes.push(`pool=${last.pool}→${curr.pool}`);
      if (last.slots !== curr.slots) changes.push(`slots=${last.slots}→${curr.slots}`);
      if (last.layers !== curr.layers) changes.push(`layers=${last.layers}→${curr.layers}`);

      if (changes.length === 0) return; // Skip if no change

      // Skip first run - bootstrap already loaded priority timesteps via submitTimestepOrders
      if (isFirstRun) {
        isFirstRun = false;
        last = curr;
        return;
      }

      DEBUG && console.log(`[QueueParams] ${changes.join(', ')}`);
      last = curr;
      this.onParamChange(params);
    });
  }

  async submitFileOrders(
    orders: FileOrder[],
    onComplete?: (index: number, buffer: ArrayBuffer) => void | Promise<void>
  ): Promise<void> {
    DEBUG && console.log(`[Queue] ${orders.length} fileorders`);

    // Sum expected bytes for all orders
    for (const order of orders) {
      this.statsTracker.pendingExpectedBytes += order.size;
    }
    this.updateStats();

    // Fetch sequentially, callback after each completes
    for (let i = 0; i < orders.length; i++) {
      const buffer = await this.fetchWithProgress(orders[i]!);
      await onComplete?.(i, buffer);
    }

    this.updateStats();
  }

  /**
   * Submit timestep orders for processing via OmService
   * Replaces any pending orders with new ones (current fetch continues)
   * Orders are processed in array order (caller should sort by priority)
   * No batched preflight - uses size estimates for instant queue start
   */
  async submitTimestepOrders(
    orders: TimestepOrder[],
    onSlice: (order: TimestepOrder, slice: OmSlice) => void | Promise<void>,
    onPreflight?: (order: TimestepOrder, actualBytes: number) => void
  ): Promise<void> {
    // Check if current fetch should be aborted (not in new orders)
    if (this.currentlyFetching && this.currentAbortController) {
      const keepCurrent = orders.some(o => o.timestep === this.currentlyFetching!.timestep);
      if (!keepCurrent) {
        console.log(`[Queue] Aborting: ${this.currentlyFetching.timestep.slice(5, 13)}`);
        this.currentAbortController.abort();
      }
    }

    // Filter out the currently fetching order (if same param AND timestep in new orders)
    const newOrders = this.currentlyFetching
      ? orders.filter(o => !(o.timestep === this.currentlyFetching!.timestep && o.param === this.currentlyFetching!.param))
      : orders;

    // Get param(s) being submitted - keep other params' pending orders
    const submittedParams = new Set(newOrders.map(o => o.param));
    const keepFromExisting = this.timestepQueue.filter(q => !submittedParams.has(q.order.param));

    // Build queue: keep other params + new orders for this param
    this.timestepQueue = [
      ...keepFromExisting,
      ...newOrders.map(order => {
      const estimatedBytes = isNaN(order.sizeEstimate) ? 0 : order.sizeEstimate;
      return {
        order,
        estimatedBytes,
        onSlice,
        onPreflight: (actualBytes: number) => {
          // Transfer from pending to active tracking
          this.statsTracker.pendingExpectedBytes -= estimatedBytes;
          this.statsTracker.activeExpectedBytes = actualBytes;
          this.statsTracker.activeActualBytes = 0;
          this.updateStats();
          onPreflight?.(order, actualBytes);
        },
      };
    }),
    ];

    // Sort queue by strategy (priority timesteps first, then by strategy)
    this.sortQueueByStrategy();

    // Calculate pending bytes from estimates (instant)
    this.statsTracker.pendingExpectedBytes = this.timestepQueue.reduce((sum, q) => sum + q.estimatedBytes, 0);
    this.updateStats();

    // Log one line per param (grouped, in order of first appearance)
    const byParam = new Map<string, TimestepOrder[]>();
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

      // Use the omParam from the order (already mapped during order creation)
      const omParam = next.order.omParam;

      try {
        await this.omService.fetch(
          next.order.url,
          omParam,
          (info) => {
            // Preflight done - report actual size for ETA correction
            next.onPreflight(info.totalBytes);
          },
          async (slice) => { await next.onSlice(next.order, slice); },
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
      this.statsTracker.activeExpectedBytes = 0;
      this.statsTracker.activeActualBytes = 0;
      this.currentlyFetching = null;
      this.currentAbortController = null;
    }

    this.processingPromise = null;
    this.updateStats();
  }

  private async fetchWithProgress(order: FileOrder): Promise<ArrayBuffer> {
    // Start tracking this file
    this.statsTracker.pendingExpectedBytes -= order.size;
    this.statsTracker.activeExpectedBytes = order.size;
    this.statsTracker.activeActualBytes = 0;

    const buffer = await fetchStreaming(
      order.url,
      {},
      (bytes) => this.onChunk(bytes)
    );

    // File complete - learn compression ratio
    this.statsTracker.learnCompressionRatio(this.statsTracker.activeExpectedBytes, this.statsTracker.activeActualBytes);
    this.statsTracker.activeExpectedBytes = 0;
    this.statsTracker.activeActualBytes = 0;

    return buffer;
  }

  private onChunk(bytes: number): void {
    this.statsTracker.onChunk(bytes);
    this.updateStats();
  }

  private updateStats(): void {
    const inFlightBytes = Array.from(this.inFlight.values())
      .reduce((sum, { task }) => sum + (task.sizeEstimate || 0), 0);
    this.statsTracker.update(
      this.taskQueue,
      this.inFlight.size,
      inFlightBytes,
      () => this.refreshAllCacheStates()
    );
  }

  /** Sort queue by loading strategy */
  private sortQueueByStrategy(): void {
    if (!this.stateService) return;
    const currentTime = this.stateService.viewState.value.time;
    const strategy = this.optionsService.options.value.dataCache.cacheStrategy as 'alternate' | 'future-first';
    sortByTimestep(this.timestepQueue, q => q.order.timestep, currentTime, strategy);
  }

  /** Handle parameter changes - reactive queue management */
  private onParamChange(params: {
    time: Date;
    poolSize: number;
    numSlots: number;
    activeLayers: string[];  // layer IDs (built-in + custom)
    strategy: string;
  }): void {
    // 1. Get window and tasks from TimestepService
    const { window, tasks } = this.timestepService.getWindowTasks(
      params.time,
      params.numSlots,
      params.activeLayers
    );

    const windowSet = new Set(window);

    // 2. Abort in-flight tasks OUTSIDE data window
    for (const [key, inFlightTask] of this.inFlight) {
      if (!windowSet.has(inFlightTask.task.timestep)) {
        DEBUG && console.log(`[Queue] Aborting out-of-window: ${fmt(inFlightTask.task.timestep)}`);
        inFlightTask.abortController.abort();
        this.inFlight.delete(key);
      }
    }

    // 3. Remove queued tasks outside data window
    this.taskQueue = this.taskQueue.filter(t => windowSet.has(t.timestep));

    // 4. Merge new tasks (avoid duplicates)
    let added = 0;
    for (const task of tasks) {
      const key = `${task.param}:${task.timestep}:${task.slabIndex}`;

      // Skip if already in flight or queued
      if (this.inFlight.has(key)) continue;
      if (this.taskQueue.some(t =>
        t.param === task.param &&
        t.timestep === task.timestep &&
        t.slabIndex === task.slabIndex
      )) continue;

      this.taskQueue.push(task);
      added++;
    }

    DEBUG && console.log(`[Queue] Tasks: ${tasks.length} from TS, +${added} new, queue=${this.taskQueue.length}, inFlight=${this.inFlight.size}`);

    // 5. Sort queue by strategy
    this.sortTaskQueue(params.time, params.strategy);

    // 6. Process queue
    this.processTaskQueue(params.poolSize);

    // 7. Update stats (deferred to avoid cycle in effect)
    queueMicrotask(() => this.updateStats());
  }

  /** Sort task queue by loading strategy */
  private sortTaskQueue(currentTime: Date, strategy: string): void {
    sortByTimestep(this.taskQueue, t => t.timestep, currentTime, strategy as 'alternate' | 'future-first');
  }

  /** Process task queue with fast/slow logic */
  private processTaskQueue(poolSize: number): void {
    // Count slow tasks currently in flight
    let slowInFlight = 0;
    for (const { task } of this.inFlight.values()) {
      if (!task.isFast) slowInFlight++;
    }

    // Start tasks up to pool size (iterate copy since startTask modifies queue)
    const tasksToProcess = [...this.taskQueue];
    for (const task of tasksToProcess) {
      if (this.inFlight.size >= poolSize) break;

      if (task.isFast) {
        // Fast tasks always start
        this.startTask(task);
      } else if (slowInFlight < 2) {
        // Slow task, network slot available
        this.startTask(task);
        slowInFlight++;
      }
      // else: skip slow task, wait for network slot
    }
  }

  /** Start a task - add to inFlight and call OmService */
  private startTask(task: QueueTask): void {
    const key = `${task.param}:${task.timestep}:${task.slabIndex}`;

    // Remove from queue
    const index = this.taskQueue.findIndex(t =>
      t.param === task.param &&
      t.timestep === task.timestep &&
      t.slabIndex === task.slabIndex
    );
    if (index >= 0) {
      this.taskQueue.splice(index, 1);
    }

    // Add to in-flight
    const abortController = new AbortController();
    this.inFlight.set(key, { task, abortController });

    DEBUG && console.log(`[Queue] Starting: ${P(task.param)} ${fmt(task.timestep)} slab=${task.slabIndex} fast=${task.isFast}`);

    // Start fetch
    this.omService.fetch(
      task.url,
      task.omParam,
      () => {
        // Preflight - update size estimate (not currently tracked in reactive mode)
      },
      async (slice) => {
        // Only process when all data is received
        if (slice.done && this.slotService) {
          this.slotService.receiveData(task.omParam, task.timestep, task.slabIndex, slice.data);
        }
      },
      (bytes) => {
        // Progress callback - update bandwidth stats
        this.onChunk(bytes);
      },
      abortController.signal
    ).then(() => {
      // Task complete
      this.onTaskComplete(key);
    }).catch((err) => {
      // Handle errors
      if (err instanceof Error && err.name === 'AbortError') {
        DEBUG && console.log(`[Queue] Aborted: ${P(task.param)} ${fmt(task.timestep)}`);
      } else {
        console.error(`[Queue] Error fetching ${P(task.param)} ${fmt(task.timestep)}:`, err);
      }
      this.inFlight.delete(key);
      this.updateStats();
    });
  }

  /** Handle task completion */
  private onTaskComplete(key: string): void {
    this.inFlight.delete(key);

    // Process more from queue
    const params = this.qsParams.value;
    this.processTaskQueue(params.poolSize);
    this.updateStats();
  }

  /** Clear all pending and in-flight tasks (called during resize) */
  clearTasks(): void {
    console.log(`[Queue] Clearing: ${this.taskQueue.length} queued, ${this.inFlight.size} in-flight`);
    for (const { abortController } of this.inFlight.values()) {
      abortController.abort();
    }
    this.inFlight.clear();
    this.taskQueue = [];
    queueMicrotask(() => this.updateStats());
  }

  /** Wait for queue to become idle (no pending or in-flight tasks) */
  waitForIdle(): Promise<void> {
    return new Promise(resolve => {
      if (this.queueStats.value.status === 'idle') {
        resolve();
        return;
      }
      const unsub = effect(() => {
        if (this.queueStats.value.status === 'idle') {
          unsub();
          resolve();
        }
      });
    });
  }

  /** Refresh cache state for all weather layers from SW */
  private refreshAllCacheStates(): void {
    const layers = this.configService.getReadyLayers().filter(isWeatherLayer);
    for (const layer of layers) {
      this.timestepService.refreshCacheState(layer);
    }
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;

    // Abort all in-flight tasks
    for (const { abortController } of this.inFlight.values()) {
      abortController.abort();
    }
    this.inFlight.clear();
    this.taskQueue = [];

    this.statsTracker.reset();
  }
}
