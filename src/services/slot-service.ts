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

export class SlotService {
  private slots: Map<string, Slot> = new Map(); // key: `${param}:${timestep}`
  private maxSlots: number;
  private freeSlotIndices: number[] = [];
  private disposeEffect: (() => void) | null = null;
  private disposeSubscribe: (() => void) | null = null;
  private loadingKeys: Set<string> = new Set();
  private initialized = false;

  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  // Active interpolation pair per param (single: only t0 used, no interpolation)
  private activePair: Map<TParam, { t0: TTimestep; t1: TTimestep | null }> = new Map();

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  /** What timesteps are needed for current time (computed by effect) */
  private readonly wanted = signal<WantedState | null>(null);

  constructor(
    private timestepService: TimestepService,
    private renderService: RenderService,
    private queueService: QueueService,
    private optionsService: OptionsService
  ) {
    this.maxSlots = this.renderService.getRenderer().getMaxTempSlots();
    this.freeSlotIndices = Array.from({ length: this.maxSlots }, (_, i) => i);

    // Wire up lerp calculation
    this.renderService.setTempLerpFn((time) => this.getTempLerp(time));

    // Effect: pure computation of wanted state + shader activation (no I/O)
    this.disposeEffect = effect(() => {
      const time = this.optionsService.options.value.viewState.time;
      if (!this.initialized) return;

      const wanted = this.computeWanted(time);
      this.tryActivateShader('temp', wanted);

      // Only update if priority changed (avoid triggering subscribe for same wanted)
      const prev = this.wanted.value;
      if (!prev || prev.priority.join() !== wanted.priority.join()) {
        this.wanted.value = wanted;
      }
    });

    // Subscribe: side effects (fetching) debounced for rapid time changes
    const debouncedFetch = debounce((w: WantedState) => this.fetchMissing('temp', w), 200);
    this.disposeSubscribe = this.wanted.subscribe(wanted => {
      if (wanted) debouncedFetch(wanted);
    });
  }

  /** Make slot key from param and timestep */
  private makeKey(param: TParam, timestep: TTimestep): string {
    return `${param}:${timestep}`;
  }

  /** Pure computation: what timesteps does current time need? */
  private computeWanted(time: Date): WantedState {
    const exactTs = this.timestepService.getExactTimestep(time);
    const centeredWindow = this.calculateLoadWindow(time);
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

  /** Activate shader if required slots are loaded, clear if not ready */
  private tryActivateShader(param: TParam, wanted: WantedState): void {
    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;  // Single mode always has 1 priority
      const slot = this.slots.get(this.makeKey(param, ts));
      if (slot?.loaded) {
        this.activePair.set(param, { t0: ts, t1: null });
        this.renderService.setTempSlots(slot.slotIndex, slot.slotIndex);
        this.renderService.setTempLoadedPoints(slot.loadedPoints);
        console.log(`[Slot] Single: ${fmt(ts)}`);
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
        this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
        this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));
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

    console.log(`[Slot] Fetching ${orders.length} timesteps`);
    this.loadTimestepsBatch(param, orders, this.optionsService.options.value.viewState.time);
  }

  /** Calculate ideal load window around time (always centered ~50/50) */
  private calculateLoadWindow(time: Date): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    // Build centered window: alternate future/past to keep balanced
    while (window.length < this.maxSlots) {
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
          if (!this.wanted.value?.window.includes(order.timestep)) {
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

    // Free slot available?
    if (this.freeSlotIndices.length > 0) {
      return this.freeSlotIndices.pop()!;
    }

    // Need to evict - find furthest from reference time
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
    console.log(`[Slot] Evicting ${evictKey} for ${key}`);
    this.slots.delete(evictKey);
    this.timestepService.setGpuUnloaded(param, evictSlot.timestep);
    return evictSlot.slotIndex;
  }

  /** Upload data to allocated slot */
  private uploadToSlot(param: TParam, timestep: TTimestep, slotIndex: number, data: Float32Array): void {
    const key = this.makeKey(param, timestep);

    const renderer = this.renderService.getRenderer();
    renderer.uploadTempDataToSlot(data, slotIndex);

    this.slots.set(key, { timestep, param, slotIndex, loaded: true, loadedPoints: data.length });
    this.timestepService.setGpuLoaded(param, timestep);
    this.timestepService.refreshCacheState(param);
    this.slotsVersion.value++;
    console.log(`[Slot] Loaded ${param}:${fmt(timestep)} → slot ${slotIndex} (${this.slots.size}/${this.maxSlots})`);

    this.updateShaderIfReady(param);
  }

  /** Update shader when a slot finishes loading (uses current wanted state) */
  private updateShaderIfReady(param: TParam): void {
    const wanted = this.wanted.value;
    if (!wanted) return;
    this.tryActivateShader(param, wanted);
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

  /** Initialize with first timestep(s) - single if exact, pair if between */
  async initialize(): Promise<void> {
    // Set data window from discovered timesteps
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.optionsService.options.value.viewState.time;
    const param: TParam = 'temp';
    const wanted = this.computeWanted(time);

    console.log(`[Slot] Initializing ${wanted.mode}: ${wanted.priority.map(fmt).join(', ')}`);

    // Track loading keys
    for (const ts of wanted.priority) {
      this.loadingKeys.add(this.makeKey(param, ts));
    }

    // Load priority timesteps
    const orders: TimestepOrder[] = wanted.priority.map(ts => ({
      url: this.timestepService.url(ts),
      param,
      timestep: ts,
      sizeEstimate: this.timestepService.getSize(param, ts),
    }));

    await this.queueService.submitTimestepOrders(
      orders,
      (order, slice) => {
        if (slice.done) {
          const slotIndex = this.allocateSlot(param, order.timestep, time);
          if (slotIndex !== null) {
            this.uploadToSlot(param, order.timestep, slotIndex, slice.data);
          }
        }
      },
      (order, actualBytes) => {
        this.timestepService.setSize(param, order.timestep, actualBytes);
      }
    );

    // Clear loading keys
    for (const ts of wanted.priority) {
      this.loadingKeys.delete(this.makeKey(param, ts));
    }

    // Set wanted state so shader activation works
    this.wanted.value = wanted;
    this.tryActivateShader(param, wanted);

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

  /** Get max slots */
  getMaxSlots(): number {
    return this.maxSlots;
  }

  /** Get current slot count */
  getSlotCount(): number {
    return this.slots.size;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    this.disposeSubscribe?.();
    this.disposeSubscribe = null;
    this.slots.clear();
  }
}
