/**
 * QueueService - Download queue with progress tracking
 *
 * Fetches files sequentially with streaming chunks for accurate ETA.
 * Learns compression ratio from completed files for better estimates.
 * Single source of truth for all pending downloads.
 */

import { computed, effect, signal } from '@preact/signals-core';
import type { FileOrder, IQueueService, TimestepOrder, OmSlice, QueueTask, TLayer } from '../../config/types';
import { fetchStreaming } from '../../utils/fetch';
import { sortByTimestep } from './sorter';
import { QueueStatsTracker } from './stats';
import { AdaptiveConcurrency } from './adaptive-concurrency';
import type { OmService } from './om-service';
import type { OptionsService } from '../options-service';
import type { StateService } from '../state-service';
import type { TimestepService } from '../timestep/timestep-service';
import type { LayerService } from '../layer/layer-service';
import type { PerfService } from '../perf-service';
import type { SlotService } from '../slot-service';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: string) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.replace(/_/g, '').slice(0, 5).toUpperCase();

/** Queued order with callback */
interface QueuedTimestepOrder {
  order: TimestepOrder;
  estimatedBytes: number;
  onSlice: (order: TimestepOrder, slice: OmSlice) => void | Promise<void>;
  onPreflight: (actualBytes: number) => void;
}

/** In-flight task with abort controller (reactive path) */
interface InFlightTask {
  task: QueueTask;
  abortController: AbortController;
}

/** In-flight bootstrap-path record: owns per-task bytes + abort. */
interface BootstrapInFlight {
  queued: QueuedTimestepOrder;
  abort: AbortController;
  expectedBytes: number;   // actual size from preflight (0 until preflight returns)
  actualBytes: number;     // accumulated from onChunk
}

export class QueueService implements IQueueService {
  // Stats tracking (bandwidth, ETA, compression learning)
  private readonly statsTracker = new QueueStatsTracker();
  private readonly adaptive: AdaptiveConcurrency;
  readonly queueStats = this.statsTracker.stats;

  /** When true, reactive effect skips — no new downloads or evictions */
  readonly paused = signal(false);

  // Bootstrap path: imperative, ordered, awaitable.
  // Used by slotService.initialize() to preload priority timesteps before the
  // reactive effect takes over (initReactive's isFirstRun guard suppresses the
  // first signal firing). Entry point: submitTimestepOrders().
  private timestepQueue: QueuedTimestepOrder[] = [];
  private bootstrapInFlight: Map<string, BootstrapInFlight> = new Map(); // key: `${param}:${timestep}`
  private processingPromise: Promise<void> | null = null;

  // File-order path (assets phase): sequential, one active fetch at a time.
  private fileActiveExpected = 0;
  private fileActiveActual = 0;

  // Reactive path (Phase 3): signal-driven, deduplicated, window-scoped.
  // Responds to time/layer/slot changes via onParamChange; aborts tasks that
  // fall outside the current data window. Entry point: the effect in initReactive().
  private taskQueue: QueueTask[] = [];
  private inFlight: Map<string, InFlightTask> = new Map(); // key: `${param}:${timestep}:${slabIndex}`
  private slotService: SlotService | null = null;
  private disposeEffect: (() => void) | null = null;

  /** Reactive parameters for queue management */
  readonly qsParams = computed(() => {
    const opts = this.optionsService.options.value;
    // Trigger recompute when layer registry changes
    this.layerService.changed.value;

    // Get all enabled layers with params
    const activeLayers = this.layerService.getAll()
      .filter(l => l.params?.length && this.layerService.isLayerEnabled(l.id))
      .map(l => l.id);

    return {
      time: this.stateService.viewState.value.time,
      poolSize: parseInt(opts.gpu.workerPoolSize, 10),
      numSlots: parseInt(opts.gpu.timeslotsPerLayer, 10),
      activeLayers,
      strategy: opts.dataCache.cacheStrategy,
    };
  });

  constructor(
    private omService: OmService,
    private optionsService: OptionsService,
    private stateService: StateService,
    private timestepService: TimestepService,
    private layerService: LayerService,
    private perfService: PerfService
  ) {
    this.adaptive = new AdaptiveConcurrency(optionsService);
  }

  /** Set SlotService reference (avoids circular dependency) */
  setSlotService(ss: SlotService): void {
    this.slotService = ss;
  }

  /** Initialize reactive queue management (skips first run - bootstrap already loaded priority) */
  initReactive(): void {
    let isFirstRun = true;
    let last = { time: '', pool: 0, slots: 0, layers: 0 };

    this.disposeEffect = effect(() => {
      const params = this.qsParams.value;
      if (this.paused.value) return;
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
   * Submit timestep orders for processing via OmService.
   * Bootstrap path: parallel fetches (up to minDownloads), map-tracked in-flight.
   * Replaces pending orders for this param; in-flight fetches that aren't in the
   * new order set are aborted. Orders processed in array order (caller sorts).
   * No batched preflight - uses size estimates for instant queue start.
   */
  async submitTimestepOrders(
    orders: TimestepOrder[],
    onSlice: (order: TimestepOrder, slice: OmSlice) => void | Promise<void>,
    onPreflight?: (order: TimestepOrder, actualBytes: number) => void
  ): Promise<void> {
    // Abort in-flight fetches whose (param, timestep) isn't in the new order set.
    const keepKeys = new Set(orders.map(o => `${o.param}:${o.timestep}`));
    for (const [key, rec] of this.bootstrapInFlight) {
      if (!keepKeys.has(key)) {
        console.log(`[Queue] Aborting: ${rec.queued.order.timestep.slice(5, 13)} (${rec.queued.order.param})`);
        rec.abort.abort();
      }
    }

    // Drop orders that are already in-flight (any slot) so we don't re-enqueue them.
    const newOrders = orders.filter(o => !this.bootstrapInFlight.has(`${o.param}:${o.timestep}`));

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
          // Transfer this order's share from pending to active tracking
          this.statsTracker.pendingExpectedBytes -= estimatedBytes;
          const rec = this.bootstrapInFlight.get(`${order.param}:${order.timestep}`);
          if (rec) rec.expectedBytes = actualBytes;
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

  /** Process timestep queue with parallel downloads (up to minDownloads concurrency).
   *  Per task: own abort + byte record, learn compression on completion, isolate errors. */
  private async processTimestepQueue(): Promise<void> {
    // Effective concurrency = min(minDownloads, workerPoolSize): the worker pool
    // is an implicit ceiling because every fetch needs a decode worker, and
    // extra fetches stall inside WorkerPool waiting for one.
    const concurrency = this.optionsService.options.value.gpu.minDownloads;
    const running = new Set<Promise<void>>();

    const startNext = (): void => {
      if (this.timestepQueue.length === 0) return;
      const next = this.timestepQueue.shift()!;
      const order = next.order;
      const key = `${order.param}:${order.timestep}`;
      const rec: BootstrapInFlight = {
        queued: next,
        abort: new AbortController(),
        expectedBytes: 0,
        actualBytes: 0,
      };
      this.bootstrapInFlight.set(key, rec);

      const task = (async () => {
        try {
          await this.omService.fetch(
            order.url,
            order.modelParam.param,
            (info) => { next.onPreflight(info.totalBytes); },
            async (slice) => { await next.onSlice(order, slice); },
            (bytes) => {
              rec.actualBytes += bytes;
              this.onChunk(bytes);
            },
            rec.abort.signal,
          );
          // Successful completion — feed compression learning with this task's actuals.
          this.statsTracker.learnCompressionRatio(rec.expectedBytes, rec.actualBytes);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            console.log(`[Queue] Aborted: ${fmt(order.timestep)} (${P(order.param)})`);
          } else {
            // Isolate error: log and move on so siblings keep running.
            console.error(`[Queue] Error fetching ${P(order.param)} ${fmt(order.timestep)}:`, err);
          }
        } finally {
          this.bootstrapInFlight.delete(key);
        }
      })();

      running.add(task);
      task.then(() => {
        running.delete(task);
        startNext();
      });
    };

    // Fill initial slots
    for (let i = 0; i < concurrency; i++) startNext();

    // Wait for all tasks (including ones spawned via startNext chaining) to finish.
    while (running.size > 0) {
      await Promise.race(running);
    }

    this.processingPromise = null;
    this.updateStats();
  }

  private async fetchWithProgress(order: FileOrder): Promise<ArrayBuffer> {
    // Start tracking this file
    this.statsTracker.pendingExpectedBytes -= order.size;
    this.fileActiveExpected = order.size;
    this.fileActiveActual = 0;

    const buffer = await fetchStreaming(
      order.url,
      {},
      (bytes) => {
        this.fileActiveActual += bytes;
        this.onChunk(bytes);
      },
    );

    // File complete - learn compression ratio
    this.statsTracker.learnCompressionRatio(this.fileActiveExpected, this.fileActiveActual);
    this.fileActiveExpected = 0;
    this.fileActiveActual = 0;

    return buffer;
  }

  private onChunk(bytes: number): void {
    this.statsTracker.onChunk(bytes);
    this.updateStats();
  }

  private updateStats(): void {
    const inFlightBytes = Array.from(this.inFlight.values())
      .reduce((sum, { task }) => sum + (task.sizeEstimate || 0), 0);
    const itemsQueued = this.taskQueue.length + this.inFlight.size
      + this.timestepQueue.length + this.bootstrapInFlight.size;
    let slowInFlight = 0;
    for (const { task } of this.inFlight.values()) {
      if (!task.isFast) slowInFlight++;
    }
    // Aggregate old-path active bytes across bootstrap map + file fetch scalars.
    let oldActiveExpected = this.fileActiveExpected;
    let oldActiveActual = this.fileActiveActual;
    for (const rec of this.bootstrapInFlight.values()) {
      oldActiveExpected += rec.expectedBytes;
      oldActiveActual += rec.actualBytes;
    }
    const workers = parseInt(this.optionsService.options.value.gpu.workerPoolSize, 10);
    this.perfService.setPool(slowInFlight, workers);
    this.statsTracker.update(
      this.taskQueue,
      this.inFlight.size,
      inFlightBytes,
      itemsQueued,
      slowInFlight,
      oldActiveExpected,
      oldActiveActual,
      () => { this.adaptive.reset(); this.refreshAllCacheStates(); },
    );
  }

  /** Sort queue by loading strategy */
  private sortQueueByStrategy(): void {
    if (!this.stateService) return;
    const currentTime = this.stateService.viewState.value.time;
    const strategy = this.optionsService.options.value.dataCache.cacheStrategy;
    sortByTimestep(this.timestepQueue, q => q.order.timestep, currentTime, strategy);
  }

  /** Handle parameter changes - reactive queue management */
  private onParamChange(params: {
    time: Date;
    poolSize: number;
    numSlots: number;
    activeLayers: (TLayer )[];  // layer IDs (built-in + custom)
    strategy: 'alternate' | 'future-first';
  }): void {
    // 1. Get window and tasks from TimestepService
    const { window, tasks } = this.timestepService.getWindowTasks(
      params.time,
      params.numSlots,
      params.activeLayers
    );

    const windowSet = new Set(window);
    const activeLayerSet = new Set(params.activeLayers);

    // 2. Abort in-flight tasks outside data window OR for inactive layers
    for (const [key, inFlightTask] of this.inFlight) {
      if (!windowSet.has(inFlightTask.task.timestep) || !activeLayerSet.has(inFlightTask.task.param)) {
        DEBUG && console.log(`[Queue] Aborting: ${fmt(inFlightTask.task.timestep)} (${inFlightTask.task.param})`);
        inFlightTask.abortController.abort();
        this.inFlight.delete(key);
      }
    }

    // 3. Remove queued tasks outside data window OR for inactive layers
    this.taskQueue = this.taskQueue.filter(t => windowSet.has(t.timestep) && activeLayerSet.has(t.param));

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
  private sortTaskQueue(currentTime: Date, strategy: 'alternate' | 'future-first'): void {
    sortByTimestep(this.taskQueue, t => t.timestep, currentTime, strategy);
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
      } else if (slowInFlight < this.adaptive.getMaxSlow()) {
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
      task.modelParam.param,
      () => {
        // Preflight - update size estimate (not currently tracked in reactive mode)
      },
      async (slice) => {
        // Only process when all data is received and task is still active
        // (clearTasks removes from inFlight before late worker messages arrive)
        if (slice.done && this.slotService && this.inFlight.has(key)) {
          this.slotService.receiveData(task.modelParam.param, task.timestep, task.slabIndex, slice.data);
        }
      },
      (bytes) => {
        // Progress callback - update bandwidth stats
        if (!task.isFast) this.adaptive.onChunk(bytes);
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
    const completed = this.inFlight.get(key);
    this.inFlight.delete(key);

    // Feed adaptive concurrency controller
    if (completed && !completed.task.isFast) {
      this.adaptive.onSlowTaskComplete();
    }

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
    for (const mp of this.layerService.getAllModelParams()) {
      this.timestepService.refreshCacheState(mp);
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
    this.adaptive.reset();
    this.adaptive.dispose();
  }
}
