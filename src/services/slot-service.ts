/**
 * SlotService - GPU slot management for timestep data
 *
 * Manages GPU texture slots, loads data via QueueService → OmService,
 * and handles load window calculation with eviction.
 *
 * Architecture:
 * - Effect: pure computation of wanted state + shader activation
 * - Subscribe: side effects (fetching) deferred via queueMicrotask
 * - onSlotLoaded: shader activation when slots complete
 */

import { effect, signal } from '@preact/signals-core';
import type { TParam, TTimestep, TimestepOrder } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { RenderService } from './render-service';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import { BootstrapService } from './bootstrap-service';
import { debounce } from '../utils/debounce';

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TParam) => param.slice(0, 4).toUpperCase();

export type LoadingStrategy = 'alternate' | 'future-first';

/** What timesteps the current time needs */
export interface WantedState {
  mode: 'single' | 'pair';
  priority: TTimestep[];    // [exactTs] for single, [t0, t1] for pair
  window: TTimestep[];      // Full prefetch window sorted by strategy
}

export interface Slot {
  timestep: TTimestep;
  param: TParam;
  slotIndex: number;
  loaded: boolean;
  loadedPoints: number;
}

/** Params that use slot-based loading */
const SLOT_PARAMS: TParam[] = ['temp', 'pressure'];

export class SlotService {
  private slots: Map<string, Slot> = new Map(); // key: `${param}:${timestep}`
  private maxSlotsPerParam: number = 8;
  private freeSlotIndicesPerParam: Map<TParam, number[]> = new Map();
  private disposeEffect: (() => void) | null = null;
  private disposeSubscribes: Map<TParam, () => void> = new Map();
  private loadingKeys: Set<string> = new Set();
  private initialized = false;

  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  // Active interpolation pair per param (single: only t0 used, no interpolation)
  private activePair: Map<TParam, { t0: TTimestep; t1: TTimestep | null }> = new Map();

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  /** What timesteps are needed for current time, per param */
  private readonly wantedPerParam: Map<TParam, ReturnType<typeof signal<WantedState | null>>> = new Map();

  constructor(
    private timestepService: TimestepService,
    private renderService: RenderService,
    private queueService: QueueService,
    private optionsService: OptionsService
  ) {
    // Get max slots per layer from options
    this.maxSlotsPerParam = this.renderService.getMaxSlotsPerLayer();

    // Initialize per-param state
    for (const param of SLOT_PARAMS) {
      this.freeSlotIndicesPerParam.set(
        param,
        Array.from({ length: this.maxSlotsPerParam }, (_, i) => i)
      );
      this.wantedPerParam.set(param, signal<WantedState | null>(null));
    }

    // Wire up lerp calculation (temp-specific for now)
    this.renderService.setTempLerpFn((time) => this.getTempLerp(time));

    // Effect: pure computation of wanted state + shader activation (no I/O)
    this.disposeEffect = effect(() => {
      const time = this.optionsService.options.value.viewState.time;
      const opts = this.optionsService.options.value;
      if (!this.initialized) return;

      // Process each enabled param
      for (const param of SLOT_PARAMS) {
        const isEnabled = this.isParamEnabled(param, opts);
        if (!isEnabled) continue;

        const wanted = this.computeWanted(time, param);
        this.activateIfReady(param, wanted);

        // Update wanted signal if priority changed
        const wantedSignal = this.wantedPerParam.get(param)!;
        const prev = wantedSignal.value;
        if (!prev || prev.priority.join() !== wanted.priority.join()) {
          wantedSignal.value = wanted;
        }
      }
    });

    // Subscribe: side effects (fetching) debounced for rapid time changes - per param
    for (const param of SLOT_PARAMS) {
      const debouncedFetch = debounce((w: WantedState) => this.fetchMissing(param, w), 200);
      const wantedSignal = this.wantedPerParam.get(param)!;
      const unsubscribe = wantedSignal.subscribe(wanted => {
        if (wanted) debouncedFetch(wanted);
      });
      this.disposeSubscribes.set(param, unsubscribe);
    }
  }

  /** Check if a param is enabled in options */
  private isParamEnabled(param: TParam, opts: typeof this.optionsService.options.value): boolean {
    switch (param) {
      case 'temp': return opts.temp.enabled;
      case 'pressure': return opts.pressure.enabled;
      case 'rain': return opts.rain.enabled;
      case 'wind': return opts.wind.enabled;
      default: return false;
    }
  }

  /** Make slot key from param and timestep */
  private makeKey(param: TParam, timestep: TTimestep): string {
    return `${param}:${timestep}`;
  }

  /** Pure computation: what timesteps does current time need? */
  private computeWanted(time: Date, param: TParam): WantedState {
    const exactTs = this.timestepService.getExactTimestep(time);
    const centeredWindow = this.calculateLoadWindow(time, param);
    const sortedWindow = this.sortByStrategy(centeredWindow);

    if (exactTs) {
      // Single mode: exact timestep is priority
      return {
        mode: 'single',
        priority: [exactTs],
        window: sortedWindow,
      };
    } else {
      // Pair mode: adjacent timesteps are priority
      const [t0, t1] = this.timestepService.adjacent(time);
      return {
        mode: 'pair',
        priority: [t0, t1],
        window: sortedWindow,
      };
    }
  }

  /**
   * Activate shader for param if required slots are loaded.
   * Single mode: needs 1 slot (exact timestep match)
   * Pair mode: needs 2 slots (interpolation between timesteps)
   * Clears activePair if slots not ready (e.g., still loading).
   */
  private activateIfReady(param: TParam, wanted: WantedState): void {
    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;  // Single mode always has 1 priority
      const slot = this.slots.get(this.makeKey(param, ts));
      if (slot?.loaded) {
        this.activePair.set(param, { t0: ts, t1: null });
        this.renderService.activateSlots(param, slot.slotIndex, slot.slotIndex, slot.loadedPoints);
        console.log(`[Slot] ${P(param)} activated: ${fmt(ts)}`);
      } else {
        this.activePair.delete(param);  // Clear stale pair
      }
    } else {
      const t0 = wanted.priority[0]!;  // Pair mode always has 2 priorities
      const t1 = wanted.priority[1]!;
      const slot0 = this.slots.get(this.makeKey(param, t0));
      const slot1 = this.slots.get(this.makeKey(param, t1));
      if (slot0?.loaded && slot1?.loaded) {
        this.activePair.set(param, { t0, t1 });
        this.renderService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        console.log(`[Slot] ${P(param)} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        this.activePair.delete(param);  // Clear stale pair
      }
    }
  }

  /** Fetch missing timesteps (side effect - called via queueMicrotask) */
  private fetchMissing(param: TParam, wanted: WantedState): void {
    if (!BootstrapService.state.value.complete) return;  // Skip during bootstrap

    const needsLoad = (ts: TTimestep) =>
      !this.slots.has(this.makeKey(param, ts)) &&
      !this.loadingKeys.has(this.makeKey(param, ts));

    // Priority timesteps first, then rest of window
    const priorityToLoad = wanted.priority.filter(needsLoad);
    const windowToLoad = wanted.window.filter(ts =>
      needsLoad(ts) && !wanted.priority.includes(ts)
    );
    const orderedToLoad = [...priorityToLoad, ...windowToLoad];

    if (orderedToLoad.length === 0) return;

    const orders: TimestepOrder[] = orderedToLoad.map(timestep => ({
      url: this.timestepService.url(timestep),
      param,
      timestep,
      sizeEstimate: this.timestepService.getSize(param, timestep),
    }));

    this.loadingKeys.clear();
    for (const timestep of orderedToLoad) {
      this.loadingKeys.add(this.makeKey(param, timestep));
    }

    console.log(`[Slot] ${P(param)} fetching ${orders.length} timesteps`);
    this.loadTimestepsBatch(param, orders, this.optionsService.options.value.viewState.time);
  }

  /** Calculate ideal load window around time (always centered ~50/50) */
  private calculateLoadWindow(time: Date, _param: TParam): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    // Build centered window: alternate future/past to keep balanced
    while (window.length < this.maxSlotsPerParam) {
      const canAddFuture = futureCursor && this.isInDataWindow(futureCursor);
      const canAddPast = pastCursor && this.isInDataWindow(pastCursor);

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

      // Prefer whichever side has fewer, or future if equal
      if (futureCount <= pastCount && canAddFuture) {
        window.push(futureCursor!);
        futureCursor = this.timestepService.next(futureCursor!);
      } else if (canAddPast) {
        window.push(pastCursor!);
        pastCursor = this.timestepService.prev(pastCursor!);
      } else if (canAddFuture) {
        window.push(futureCursor!);
        futureCursor = this.timestepService.next(futureCursor!);
      }
    }

    return window;
  }

  /** Sort window by loading strategy (t0, t1 always first) */
  private sortByStrategy(window: TTimestep[]): TTimestep[] {
    if (window.length <= 2) return window;

    const [t0, t1] = window;
    const rest = window.slice(2);
    const past = rest.filter(ts => ts < t0!).sort().reverse(); // newest past first
    const future = rest.filter(ts => ts > t1!).sort(); // oldest future first

    switch (this.strategy) {
      case 'future-first':
        return [t0!, t1!, ...future, ...past];

      case 'alternate':
      default: {
        // Interleave: f1, p1, f2, p2, ...
        const interleaved: TTimestep[] = [];
        const maxLen = Math.max(future.length, past.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < future.length) interleaved.push(future[i]!);
          if (i < past.length) interleaved.push(past[i]!);
        }
        return [t0!, t1!, ...interleaved];
      }
    }
  }

  /** Check if timestep is within data window */
  private isInDataWindow(timestep: TTimestep): boolean {
    return timestep >= this.dataWindowStart && timestep <= this.dataWindowEnd;
  }

  /** Load multiple timesteps as batch via QueueService */
  private loadTimestepsBatch(param: TParam, orders: TimestepOrder[], _referenceTime: Date): void {
    // Fire and forget - QueueService handles queue replacement
    this.queueService.submitTimestepOrders(
      orders,
      (order, slice) => {
        if (slice.done) {
          // Skip if timestep no longer in wanted window (user moved away)
          const wantedSignal = this.wantedPerParam.get(param);
          if (!wantedSignal?.value?.window.includes(order.timestep)) {
            this.loadingKeys.delete(this.makeKey(param, order.timestep));
            return;
          }
          // Allocate slot just-in-time - use CURRENT time for eviction (user may have moved)
          const slotIndex = this.allocateSlot(param, order.timestep, this.optionsService.options.value.viewState.time);
          if (slotIndex !== null) {
            this.uploadToSlot(param, order.timestep, slotIndex, slice.data);
          }
          // Clear loading key when this specific order completes
          this.loadingKeys.delete(this.makeKey(param, order.timestep));
        }
      },
      (order, actualBytes) => {
        // Store actual size for future estimates
        this.timestepService.setSize(param, order.timestep, actualBytes);
      }
    ).catch(err => {
      console.warn(`[Slot] Failed to load batch:`, err);
    });
  }

  /** Allocate a slot for a timestep, evicting if necessary */
  private allocateSlot(param: TParam, timestep: TTimestep, referenceTime: Date): number | null {
    const key = this.makeKey(param, timestep);

    // Already has slot?
    const existing = this.slots.get(key);
    if (existing) return existing.slotIndex;

    // Free slot available for this param?
    const freeIndices = this.freeSlotIndicesPerParam.get(param)!;
    if (freeIndices.length > 0) {
      return freeIndices.pop()!;
    }

    // Need to evict - find furthest from reference time (only slots for this param)
    const candidates = [...this.slots.entries()]
      .filter(([, slot]) => slot.param === param && slot.loaded)
      .sort((a, b) => {
        const distA = Math.abs(this.timestepService.toDate(a[1].timestep).getTime() - referenceTime.getTime());
        const distB = Math.abs(this.timestepService.toDate(b[1].timestep).getTime() - referenceTime.getTime());
        return distB - distA; // Furthest first
      });

    if (candidates.length === 0) {
      console.warn(`[Slot] No slots available for ${key}`);
      return null;
    }

    const [evictKey, evictSlot] = candidates[0]!;
    console.log(`[Slot] ${P(param)} evict ${fmt(evictSlot.timestep)} for ${fmt(timestep)}`);
    this.slots.delete(evictKey);
    this.timestepService.setGpuUnloaded(param, evictSlot.timestep);
    return evictSlot.slotIndex;
  }

  /** Upload data to allocated slot */
  private uploadToSlot(param: TParam, timestep: TTimestep, slotIndex: number, data: Float32Array): void {
    const key = this.makeKey(param, timestep);

    // Use generic upload method - RenderService routes to param-specific handler
    this.renderService.uploadToSlot(param, data, slotIndex);

    this.slots.set(key, { timestep, param, slotIndex, loaded: true, loadedPoints: data.length });
    this.timestepService.setGpuLoaded(param, timestep);
    this.timestepService.refreshCacheState(param);
    this.slotsVersion.value++;

    const paramSlots = [...this.slots.values()].filter(s => s.param === param).length;
    console.log(`[Slot] ${P(param)} loaded ${fmt(timestep)} → slot ${slotIndex} (${paramSlots}/${this.maxSlotsPerParam})`);

    this.updateShaderIfReady(param);
  }

  /** Update shader when a slot finishes loading (uses current wanted state) */
  private updateShaderIfReady(param: TParam): void {
    const wantedSignal = this.wantedPerParam.get(param);
    const wanted = wantedSignal?.value;
    if (!wanted) return;
    this.activateIfReady(param, wanted);
  }

  /** Calculate lerp for shader interpolation: -1 = not ready, -2 = single slot mode, 0-1 = interpolate */
  getTempLerp(currentTime: Date): number {
    const pair = this.activePair.get('temp');
    if (!pair) return -1;

    // Single slot mode: no interpolation needed
    if (pair.t1 === null) return -2;

    const t0 = this.timestepService.toDate(pair.t0).getTime();
    const t1 = this.timestepService.toDate(pair.t1).getTime();
    const tc = currentTime.getTime();

    if (tc < t0 || tc > t1) return -1;
    return (tc - t0) / (t1 - t0);
  }

  /** Initialize with priority timesteps for all enabled params */
  async initialize(onProgress?: (param: TParam, index: number, total: number) => void): Promise<void> {
    // Set data window from discovered timesteps
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.optionsService.options.value.viewState.time;
    const opts = this.optionsService.options.value;

    // Get enabled params that use slots
    const enabledParams = SLOT_PARAMS.filter(p => this.isParamEnabled(p, opts));
    if (enabledParams.length === 0) {
      this.initialized = true;
      console.log('[Slot] Initialized (no layers enabled)');
      return;
    }

    // Build orders for all enabled params
    const allOrders: TimestepOrder[] = [];
    const wantedByParam = new Map<TParam, WantedState>();

    for (const param of enabledParams) {
      const wanted = this.computeWanted(time, param);
      wantedByParam.set(param, wanted);

      console.log(`[Slot] ${P(param)} init ${wanted.mode}: ${wanted.priority.map(fmt).join(', ')}`);

      for (const ts of wanted.priority) {
        this.loadingKeys.add(this.makeKey(param, ts));
        allOrders.push({
          url: this.timestepService.url(ts),
          param,
          timestep: ts,
          sizeEstimate: this.timestepService.getSize(param, ts),
        });
      }
    }

    // Track completed orders for progress
    let completed = 0;
    const total = allOrders.length;

    // Load all priority timesteps
    await this.queueService.submitTimestepOrders(
      allOrders,
      (order, slice) => {
        if (slice.done) {
          const slotIndex = this.allocateSlot(order.param, order.timestep, time);
          if (slotIndex !== null) {
            this.uploadToSlot(order.param, order.timestep, slotIndex, slice.data);
          }
          completed++;
          onProgress?.(order.param, completed, total);
        }
      },
      (order, actualBytes) => {
        this.timestepService.setSize(order.param, order.timestep, actualBytes);
      }
    );

    // Clear loading keys and activate shaders
    for (const param of enabledParams) {
      const wanted = wantedByParam.get(param)!;
      for (const ts of wanted.priority) {
        this.loadingKeys.delete(this.makeKey(param, ts));
      }
      const wantedSignal = this.wantedPerParam.get(param)!;
      wantedSignal.value = wanted;
      this.activateIfReady(param, wanted);
    }

    this.initialized = true;
    this.slotsVersion.value++;
    console.log('[Slot] Initialized');
  }

  /** Get loaded timesteps for timebar */
  getLoadedTimestamps(param: TParam): TTimestep[] {
    const loaded: TTimestep[] = [];
    for (const slot of this.slots.values()) {
      if (slot.param === param && slot.loaded) {
        loaded.push(slot.timestep);
      }
    }
    return loaded.sort();
  }

  /** Get active pair for a param (t1 = null means single slot mode) */
  getActivePair(param: TParam): { t0: TTimestep; t1: TTimestep | null } | null {
    return this.activePair.get(param) ?? null;
  }

  /** Get data window */
  getDataWindow(): { start: TTimestep; end: TTimestep } {
    return { start: this.dataWindowStart, end: this.dataWindowEnd };
  }

  /** Get current strategy from options */
  private get strategy(): LoadingStrategy {
    return this.optionsService.options.value.dataCache.cacheStrategy as LoadingStrategy;
  }

  /** Get max slots per layer */
  getMaxSlots(): number {
    return this.maxSlotsPerParam;
  }

  /** Get current slot count for a param */
  getSlotCount(param?: TParam): number {
    if (param) {
      return [...this.slots.values()].filter(s => s.param === param).length;
    }
    return this.slots.size;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    for (const unsubscribe of this.disposeSubscribes.values()) {
      unsubscribe();
    }
    this.disposeSubscribes.clear();
    this.slots.clear();
  }
}
