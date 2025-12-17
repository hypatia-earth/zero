/**
 * SlotService - GPU slot orchestration for timestep data
 *
 * Orchestrates ParamSlots instances (one per weather layer).
 * Handles: time changes → wanted computation → fetch triggering → shader activation.
 *
 * Architecture:
 * - ParamSlots: per-param state (slots, loading, activePair)
 * - Effect: pure computation of wanted state + shader activation
 * - Subscribe: side effects (fetching) deferred via debounce
 */

import { effect, signal } from '@preact/signals-core';
import type { TParam, TTimestep, TimestepOrder } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { RenderService } from './render-service';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import { BootstrapService } from './bootstrap-service';
import { debounce } from '../utils/debounce';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TParam) => param.slice(0, 4).toUpperCase();

/** Params that use slot-based loading */
const SLOT_PARAMS: TParam[] = ['temp', 'pressure'];

export class SlotService {
  private paramSlots: Map<TParam, ParamSlots> = new Map();
  private maxSlotsPerParam: number = 8;
  private disposeEffect: (() => void) | null = null;
  private disposeSubscribes: Map<TParam, () => void> = new Map();
  private initialized = false;

  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  constructor(
    private timestepService: TimestepService,
    private renderService: RenderService,
    private queueService: QueueService,
    private optionsService: OptionsService
  ) {
    this.maxSlotsPerParam = this.renderService.getMaxSlotsPerLayer();

    // Create ParamSlots for each slot-based layer
    for (const param of SLOT_PARAMS) {
      this.paramSlots.set(param, createParamSlots(param, this.maxSlotsPerParam));
    }

    // Wire up lerp calculation (temp-specific for now)
    this.renderService.setTempLerpFn((time) => this.getTempLerp(time));

    // Effect: pure computation of wanted state + shader activation (no I/O)
    this.disposeEffect = effect(() => {
      const time = this.optionsService.options.value.viewState.time;
      const opts = this.optionsService.options.value;
      if (!this.initialized) return;

      for (const param of SLOT_PARAMS) {
        if (!this.isParamEnabled(param, opts)) continue;

        const ps = this.paramSlots.get(param)!;
        const wanted = this.computeWanted(time, param);
        this.activateIfReady(param, ps, wanted);

        // Update wanted signal if priority changed
        const prev = ps.wanted.value;
        if (!prev || prev.priority.join() !== wanted.priority.join()) {
          ps.wanted.value = wanted;
        }
      }
    });

    // Subscribe: side effects (fetching) debounced - per param
    for (const param of SLOT_PARAMS) {
      const ps = this.paramSlots.get(param)!;
      const debouncedFetch = debounce((w: WantedState) => this.fetchMissing(param, ps, w), 200);
      const unsubscribe = ps.wanted.subscribe(wanted => {
        if (!BootstrapService.state.value.complete) return;
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

  /** Pure computation: what timesteps does current time need? */
  private computeWanted(time: Date, param: TParam): WantedState {
    const exactTs = this.timestepService.getExactTimestep(time);
    const window = this.calculateLoadWindow(time, param);

    if (exactTs) {
      return { mode: 'single', priority: [exactTs], window };
    } else {
      const [t0, t1] = this.timestepService.adjacent(time);
      return { mode: 'pair', priority: [t0, t1], window };
    }
  }

  /**
   * Activate shader if required slots are loaded.
   * Single mode: 1 slot, Pair mode: 2 slots for interpolation.
   */
  private activateIfReady(param: TParam, ps: ParamSlots, wanted: WantedState): void {
    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;
      const slot = ps.getSlot(ts);
      if (slot?.loaded) {
        ps.setActivePair({ t0: ts, t1: null });
        this.renderService.activateSlots(param, slot.slotIndex, slot.slotIndex, slot.loadedPoints);
        console.log(`[Slot] ${P(param)} activated: ${fmt(ts)}`);
      } else {
        ps.setActivePair(null);
      }
    } else {
      const t0 = wanted.priority[0]!;
      const t1 = wanted.priority[1]!;
      const slot0 = ps.getSlot(t0);
      const slot1 = ps.getSlot(t1);
      if (slot0?.loaded && slot1?.loaded) {
        ps.setActivePair({ t0, t1 });
        this.renderService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        console.log(`[Slot] ${P(param)} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        ps.setActivePair(null);
      }
    }
  }

  /** Fetch missing timesteps */
  private fetchMissing(param: TParam, ps: ParamSlots, wanted: WantedState): void {
    if (!BootstrapService.state.value.complete) return;

    const needsLoad = (ts: TTimestep) => !ps.hasSlot(ts) && !ps.isLoading(ts);

    const priorityToLoad = wanted.priority.filter(needsLoad);
    const windowToLoad = wanted.window.filter(ts => needsLoad(ts) && !wanted.priority.includes(ts));
    const orderedToLoad = [...priorityToLoad, ...windowToLoad];

    if (orderedToLoad.length === 0) return;

    const orders: TimestepOrder[] = orderedToLoad.map(timestep => ({
      url: this.timestepService.url(timestep),
      param,
      timestep,
      sizeEstimate: this.timestepService.getSize(param, timestep),
    }));

    ps.setLoading(orderedToLoad);
    console.log(`[Slot] ${P(param)} fetching ${orders.length} timesteps`);
    this.loadTimestepsBatch(param, ps, orders);
  }

  /** Calculate ideal load window around time */
  private calculateLoadWindow(time: Date, _param: TParam): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    while (window.length < this.maxSlotsPerParam) {
      const canAddFuture = futureCursor && this.isInDataWindow(futureCursor);
      const canAddPast = pastCursor && this.isInDataWindow(pastCursor);

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

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

  /** Check if timestep is within data window */
  private isInDataWindow(timestep: TTimestep): boolean {
    return timestep >= this.dataWindowStart && timestep <= this.dataWindowEnd;
  }

  /** Load timesteps via QueueService */
  private loadTimestepsBatch(param: TParam, ps: ParamSlots, orders: TimestepOrder[]): void {
    this.queueService.submitTimestepOrders(
      orders,
      (order, slice) => {
        if (slice.done) {
          // Skip if timestep no longer wanted
          if (!ps.wanted.value?.window.includes(order.timestep)) {
            ps.clearLoading(order.timestep);
            return;
          }

          const currentTime = this.optionsService.options.value.viewState.time;
          const result = ps.allocateSlot(
            order.timestep,
            currentTime,
            (ts) => this.timestepService.toDate(ts)
          );

          if (result) {
            if (result.evicted) {
              this.timestepService.setGpuUnloaded(param, result.evicted);
            }
            this.renderService.uploadToSlot(param, slice.data, result.slotIndex);
            ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
            this.timestepService.setGpuLoaded(param, order.timestep);
            this.timestepService.refreshCacheState(param);
            this.slotsVersion.value++;
            this.updateShaderIfReady(param, ps);
          }

          ps.clearLoading(order.timestep);
        }
      },
      (order, actualBytes) => {
        this.timestepService.setSize(order.param, order.timestep, actualBytes);
      }
    ).catch(err => {
      console.warn(`[Slot] Failed to load batch:`, err);
    });
  }

  /** Update shader when a slot finishes loading */
  private updateShaderIfReady(param: TParam, ps: ParamSlots): void {
    const wanted = ps.wanted.value;
    if (!wanted) return;
    this.activateIfReady(param, ps, wanted);
  }

  /** Calculate lerp for shader interpolation */
  getTempLerp(currentTime: Date): number {
    const ps = this.paramSlots.get('temp');
    const pair = ps?.getActivePair();
    if (!pair) return -1;

    if (pair.t1 === null) return -2;  // Single slot mode

    const t0 = this.timestepService.toDate(pair.t0).getTime();
    const t1 = this.timestepService.toDate(pair.t1).getTime();
    const tc = currentTime.getTime();

    if (tc < t0 || tc > t1) return -1;
    return (tc - t0) / (t1 - t0);
  }

  /** Initialize with priority timesteps for all enabled params */
  async initialize(onProgress?: (param: TParam, index: number, total: number) => void): Promise<void> {
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.optionsService.options.value.viewState.time;
    const opts = this.optionsService.options.value;

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
      const ps = this.paramSlots.get(param)!;
      const wanted = this.computeWanted(time, param);
      wantedByParam.set(param, wanted);

      console.log(`[Slot] ${P(param)} init ${wanted.mode}: ${wanted.priority.map(fmt).join(', ')}`);

      for (const ts of wanted.priority) {
        ps.setLoading([ts]);
        allOrders.push({
          url: this.timestepService.url(ts),
          param,
          timestep: ts,
          sizeEstimate: this.timestepService.getSize(param, ts),
        });
      }
    }

    let completed = 0;
    const total = allOrders.length;

    await this.queueService.submitTimestepOrders(
      allOrders,
      (order, slice) => {
        if (slice.done) {
          const ps = this.paramSlots.get(order.param)!;
          const result = ps.allocateSlot(
            order.timestep,
            time,
            (ts) => this.timestepService.toDate(ts)
          );

          if (result) {
            this.renderService.uploadToSlot(order.param, slice.data, result.slotIndex);
            ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
            this.timestepService.setGpuLoaded(order.param, order.timestep);
          }

          completed++;
          onProgress?.(order.param, completed, total);
        }
      },
      (order, actualBytes) => {
        this.timestepService.setSize(order.param, order.timestep, actualBytes);
      }
    );

    // Activate shaders
    for (const param of enabledParams) {
      const ps = this.paramSlots.get(param)!;
      const wanted = wantedByParam.get(param)!;
      ps.wanted.value = wanted;
      this.activateIfReady(param, ps, wanted);
    }

    this.initialized = true;
    this.slotsVersion.value++;
    console.log('[Slot] Initialized');
  }

  /** Get active pair for a param */
  getActivePair(param: TParam): { t0: TTimestep; t1: TTimestep | null } | null {
    return this.paramSlots.get(param)?.getActivePair() ?? null;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    for (const unsubscribe of this.disposeSubscribes.values()) {
      unsubscribe();
    }
    this.disposeSubscribes.clear();
    for (const ps of this.paramSlots.values()) {
      ps.dispose();
    }
    this.paramSlots.clear();
  }
}
