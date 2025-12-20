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
import { isWeatherLayer, isWeatherTextureLayer, type TLayer, type TWeatherLayer, type TTimestep, type TimestepOrder, type TWeatherTextureLayer } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { RenderService } from './render-service';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import { LayerStore } from './layer-store';
import { BootstrapService } from './bootstrap-service';
import { debounce } from '../utils/debounce';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

const DEBUG = false;
const DEBUG_MONKEY = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TWeatherLayer) => param.slice(0, 4).toUpperCase();


export class SlotService {
  private paramSlots: Map<TWeatherLayer, ParamSlots> = new Map();
  private layerStores: Map<TWeatherLayer, LayerStore> = new Map();
  private readyLayers: TLayer[] = [];
  private readyWeatherLayers: TWeatherLayer[] = [];
  private timeslotsPerLayer: number = 8;
  private disposeEffect: (() => void) | null = null;
  private disposeResizeEffect: (() => void) | null = null;
  private disposeSubscribes: Map<TWeatherLayer, () => void> = new Map();
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
    private optionsService: OptionsService,
    private configService: ConfigService,
  ) {
    // All layers use per-slot buffers with rebinding - no binding size limit
    // Only limited by total VRAM (handled by OOM on allocation)
    this.timeslotsPerLayer = this.renderService.getMaxSlotsPerLayer();
    this.readyLayers = this.configService.getReadyLayers();
    this.readyWeatherLayers = this.readyLayers.filter(isWeatherLayer);
    console.log(`[Slot] ${this.timeslotsPerLayer} timeslots for: ${this.readyWeatherLayers.join(', ')}`);

    // Create LayerStores for weather layers with slab definitions
    this.initializeLayerStores();

    // Create ParamSlots for each slot-based layer
    for (const param of this.readyWeatherLayers) {
      this.paramSlots.set(param, createParamSlots(param, this.timeslotsPerLayer));
    }

    // Wire up lerp calculations
    this.renderService.setTempLerpFn((time) => this.getLerp('temp', time));
    this.renderService.setPressureLerpFn((time) => this.getLerp('pressure', time));

    // Wire up pressure resolution change callback (re-regrid slots with raw data)
    this.renderService.setPressureResolutionChangeFn((slotsNeedingRegrid) => {
      const store = this.layerStores.get('pressure');
      if (!store) return;
      for (const slotIndex of slotsNeedingRegrid) {
        const buffer = store.getSlotBuffer(slotIndex, 0);
        if (buffer) {
          this.renderService.triggerPressureRegrid(slotIndex, buffer);
          console.log(`[Slot] Re-regrid pressure slot ${slotIndex}`);
        }
      }
    });

    // Wire up data-ready functions for each slot-based param
    for (const param of this.readyWeatherLayers) {
      this.renderService.setDataReadyFn(param, () => this.getActiveTimesteps(param).length > 0);
    }

    // Effect: pure computation of wanted state + shader activation (no I/O)
    this.disposeEffect = effect(() => {
      const time = this.optionsService.options.value.viewState.time;
      const opts = this.optionsService.options.value;
      if (!this.initialized) return;

      for (const param of this.readyWeatherLayers) {
        if (!opts[param].enabled) continue;

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
    for (const param of this.readyWeatherLayers) {
      const ps = this.paramSlots.get(param)!;
      const debouncedFetch = debounce((w: WantedState) => this.fetchMissing(param, ps, w), 200);
      const unsubscribe = ps.wanted.subscribe(wanted => {
        if (!BootstrapService.state.value.complete) return;
        if (wanted) debouncedFetch(wanted);
      });
      this.disposeSubscribes.set(param, unsubscribe);
    }

    // Effect: resize LayerStores when timeslotsPerLayer option changes
    let lastTimeslots = this.timeslotsPerLayer;
    this.disposeResizeEffect = effect(() => {
      const newTimeslots = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

      if (newTimeslots === lastTimeslots) return;

      console.log(`[Slot] Resizing stores: ${lastTimeslots} → ${newTimeslots} timeslots`);

      // Try resize all LayerStores - rollback on any failure
      const resizedStores: TWeatherLayer[] = [];
      let failed = false;

      for (const [param, store] of this.layerStores) {
        try {
          store.resize(newTimeslots);
          resizedStores.push(param);
        } catch (err) {
          console.error(`[Slot] OOM resizing ${param}:`, err);
          failed = true;
          break;
        }
      }

      if (failed) {
        // Rollback: resize already-resized stores back to old size
        console.warn(`[Slot] OOM - reverting to ${lastTimeslots} timeslots`);
        for (const param of resizedStores) {
          try {
            this.layerStores.get(param)?.resize(lastTimeslots);
          } catch {
            console.error(`[Slot] Failed to rollback ${param}`);
          }
        }

        // Revert option (without triggering this effect again)
        queueMicrotask(() => {
          this.optionsService.options.value.gpu.timeslotsPerLayer = String(lastTimeslots) as typeof this.optionsService.options.value.gpu.timeslotsPerLayer;
        });
        return;
      }

      // Update ParamSlots capacity
      const isGrowing = newTimeslots > lastTimeslots;
      for (const param of this.readyWeatherLayers) {
        if (isGrowing) {
          // Growing: just add more free indices, preserve slots
          this.paramSlots.get(param)?.grow(newTimeslots);
        } else {
          // Shrinking: recreate (TODO: preserve closest to current time)
          const oldPs = this.paramSlots.get(param);
          oldPs?.dispose();
          this.paramSlots.set(param, createParamSlots(param, newTimeslots));
        }
      }

      this.timeslotsPerLayer = newTimeslots;
      lastTimeslots = newTimeslots;
      this.slotsVersion.value++;
    });
  }

  /** Pure computation: what timesteps does current time need? */
  private computeWanted(time: Date, param: TWeatherLayer): WantedState {
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
   * Skips if already activated with same pair (avoids redundant GPU updates).
   */
  private activateIfReady(param: TWeatherLayer, ps: ParamSlots, wanted: WantedState): void {
    const current = ps.getActiveTimesteps();
    const pcode = P(param);

    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;
      const slot = ps.getSlot(ts);
      if (slot?.loaded) {
        // Skip if already activated with same timestep
        if (current.length === 1 && current[0] === ts) {
          DEBUG && console.log(`[Slot] ${pcode} skip (same): ${fmt(ts)}`);
          return;
        }
        ps.setActiveTimesteps([ts]);

        // Rebind buffers for texture layers (per-slot mode)
        if (isWeatherTextureLayer(param)) {
          this.rebindTextureLayerBuffers(param, slot.slotIndex, slot.slotIndex);
        }

        this.renderService.activateSlots(param, slot.slotIndex, slot.slotIndex, slot.loadedPoints);
        console.log(`[Slot] ${pcode} activated: ${fmt(ts)}`);
      } else {
        DEBUG_MONKEY && console.log(`[Monkey] ${pcode} CANNOT activate single ${fmt(ts)}: slot=${!!slot} loaded=${slot?.loaded}`);
        ps.setActiveTimesteps([]);
      }
    } else {
      const t0 = wanted.priority[0]!;
      const t1 = wanted.priority[1]!;
      const slot0 = ps.getSlot(t0);
      const slot1 = ps.getSlot(t1);
      if (slot0?.loaded && slot1?.loaded) {
        // Skip if already activated with same pair
        if (current.length === 2 && current[0] === t0 && current[1] === t1) {
          DEBUG && console.log(`[Slot] ${pcode} skip (same): ${fmt(t0)} → ${fmt(t1)}`);
          return;
        }
        ps.setActiveTimesteps([t0, t1]);

        // Rebind buffers for texture layers (per-slot mode)
        if (isWeatherTextureLayer(param)) {
          this.rebindTextureLayerBuffers(param, slot0.slotIndex, slot1.slotIndex);
        }

        this.renderService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        console.log(`[Slot] ${pcode} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        DEBUG_MONKEY && console.log(`[Monkey] ${pcode} CANNOT activate pair ${fmt(t0)}→${fmt(t1)}: slot0=${!!slot0}/${slot0?.loaded} slot1=${!!slot1}/${slot1?.loaded}`);
        ps.setActiveTimesteps([]);
      }
    }
  }

  /** Rebind texture layer slot buffers to renderer */
  private rebindTextureLayerBuffers(param: TWeatherTextureLayer, slotIndex0: number, slotIndex1: number): void {
    const store = this.layerStores.get(param);
    if (!store) return;

    const buffer0 = store.getSlotBuffer(slotIndex0, 0);  // slab 0
    const buffer1 = store.getSlotBuffer(slotIndex1, 0);

    if (buffer0 && buffer1) {
      this.renderService.setTextureLayerBuffers(param, buffer0, buffer1);
    } else {
      console.warn(`[Slot] Missing ${param} buffer: slot0=${!!buffer0} slot1=${!!buffer1}`);
    }
  }

  /** Upload data to slot via LayerStore */
  private uploadData(param: TWeatherLayer, data: Float32Array, slotIndex: number): void {
    const store = this.layerStores.get(param);
    if (!store) return;

    store.writeToSlab(0, slotIndex, data);  // slab 0 for single-slab layers

    // Pressure needs regrid after upload (pass the per-slot buffer)
    if (param === 'pressure') {
      const buffer = store.getSlotBuffer(slotIndex, 0);
      if (buffer) {
        this.renderService.triggerPressureRegrid(slotIndex, buffer);
      }
    }
  }

  /** Fetch missing timesteps */
  private fetchMissing(param: TWeatherLayer, ps: ParamSlots, wanted: WantedState): void {
    if (!BootstrapService.state.value.complete) return;

    const needsLoad = (ts: TTimestep) => !ps.hasSlot(ts) && !ps.isLoading(ts);

    const priorityToLoad = wanted.priority.filter(needsLoad);
    const windowToLoad = wanted.window.filter(ts => needsLoad(ts) && !wanted.priority.includes(ts));
    const orderedToLoad = [...priorityToLoad, ...windowToLoad];

    // Include priority timesteps that are already loading - this tells QueueService
    // not to abort them (abort logic checks if timestep is in new orders)
    const priorityAlreadyLoading = wanted.priority.filter(ts => ps.isLoading(ts));

    if (orderedToLoad.length === 0 && priorityAlreadyLoading.length === 0) return;

    // Build orders: new loads + already-loading priority (to prevent abort)
    const allOrderTimesteps = [...orderedToLoad, ...priorityAlreadyLoading];
    const orders: TimestepOrder[] = allOrderTimesteps.map(timestep => ({
      url: this.timestepService.url(timestep),
      param,
      timestep,
      sizeEstimate: this.timestepService.getSize(param, timestep),
    }));

    ps.setLoading(orderedToLoad);  // Only mark new ones as loading
    console.log(`[Slot] ${P(param)} fetching ${orderedToLoad.length} timesteps (${priorityAlreadyLoading.length} priority in-flight)`);
    this.loadTimestepsBatch(param, ps, orders);
  }

  /** Calculate ideal load window around time */
  private calculateLoadWindow(time: Date, _param: TWeatherLayer): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    while (window.length < this.timeslotsPerLayer) {
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
  private loadTimestepsBatch(param: TWeatherLayer, ps: ParamSlots, orders: TimestepOrder[]): void {
    this.queueService.submitTimestepOrders(
      orders,
      (order, slice) => {
        if (slice.done) {
          // Skip if timestep no longer wanted
          if (!ps.wanted.value?.window.includes(order.timestep)) {
            // SUSPECT 2: Old data skipped - is new data being fetched?
            DEBUG_MONKEY && console.log(`[Monkey] ${P(param)} SKIP ${fmt(order.timestep)} - not in window [${ps.wanted.value?.window.slice(0, 3).map(fmt).join(', ')}...]`);
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
            if (result.evicted && result.evictedSlotIndex !== null) {
              this.timestepService.setGpuUnloaded(param, result.evicted);
              // Destroy evicted slot's buffers
              this.layerStores.get(param)?.destroySlotBuffers(result.evictedSlotIndex);
            }
            // Ensure buffer exists for this slot
            this.layerStores.get(param)?.ensureSlotBuffers(result.slotIndex);
            this.uploadData(param, slice.data, result.slotIndex);
            ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
            this.timestepService.setGpuLoaded(param, order.timestep);
            this.timestepService.refreshCacheState(param);
            this.slotsVersion.value++;
            DEBUG_MONKEY && console.log(`[Monkey] ${P(param)} loaded ${fmt(order.timestep)} → slot ${result.slotIndex}, calling updateShaderIfReady`);
            this.updateShaderIfReady(param, ps);
          } else {
            // SUSPECT 1: allocateSlot returned null - data lost!
            console.warn(`[Monkey] ${P(param)} ALLOCATION FAILED for ${fmt(order.timestep)} - all slots loading?`);
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
  private updateShaderIfReady(param: TWeatherLayer, ps: ParamSlots): void {
    const wanted = ps.wanted.value;
    if (!wanted) {
      DEBUG_MONKEY && console.warn(`[Monkey] ${P(param)} updateShaderIfReady: wanted is NULL!`);
      return;
    }
    DEBUG_MONKEY && console.log(`[Monkey] ${P(param)} updateShaderIfReady: wanted=${wanted.mode} [${wanted.priority.map(fmt).join(', ')}]`);
    this.activateIfReady(param, ps, wanted);
  }

  /** Calculate lerp for shader interpolation */
  getLerp(param: TWeatherLayer, currentTime: Date): number {
    const ps = this.paramSlots.get(param);
    const active = ps?.getActiveTimesteps();
    if (!active || active.length === 0) return -1;

    if (active.length === 1) return -2;  // Single timestep mode

    const t0 = this.timestepService.toDate(active[0]!).getTime();
    const t1 = this.timestepService.toDate(active[1]!).getTime();
    const tc = currentTime.getTime();

    if (tc < t0 || tc > t1) return -1;
    return (tc - t0) / (t1 - t0);
  }

  /** Initialize with priority timesteps for all enabled params */
  async initialize(onProgress?: (param: TWeatherLayer, index: number, total: number) => void): Promise<void> {
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.optionsService.options.value.viewState.time;
    const opts = this.optionsService.options.value;

    const enabledParams = this.readyWeatherLayers.filter(p => opts[p].enabled);
    if (enabledParams.length === 0) {
      this.initialized = true;
      console.log('[Slot] Initialized (no layers enabled)');
      return;
    }

    // Build orders for all enabled params
    const allOrders: TimestepOrder[] = [];
    const wantedByParam = new Map<TWeatherLayer, WantedState>();

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
            // Ensure buffer exists for this slot
            this.layerStores.get(order.param)?.ensureSlotBuffers(result.slotIndex);
            this.uploadData(order.param, slice.data, result.slotIndex);
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

  /** Get active timesteps for a param (0, 1, or 2 items) */
  getActiveTimesteps(param: TWeatherLayer): TTimestep[] {
    return this.paramSlots.get(param)?.getActiveTimesteps() ?? [];
  }

  /** Get GPU memory stats across all layer stores */
  getMemoryStats(): {
    allocatedMB: number;
    capacityMB: number;
    layers: Map<string, { allocatedMB: number; capacityMB: number }>;
  } {
    let totalAllocated = 0;
    let totalCapacity = 0;
    const layers = new Map<string, { allocatedMB: number; capacityMB: number }>();

    for (const [param, store] of this.layerStores) {
      const sizeMB = store.timeslotSizeMB;
      const allocated = store.getAllocatedCount() * sizeMB;
      const capacity = store.getTimeslotCount() * sizeMB;

      totalAllocated += allocated;
      totalCapacity += capacity;
      layers.set(param, { allocatedMB: allocated, capacityMB: capacity });
    }

    return {
      allocatedMB: totalAllocated,
      capacityMB: totalCapacity,
      layers,
    };
  }

  /** Initialize LayerStores for weather layers with slab definitions */
  private initializeLayerStores(): void {
    const device = this.renderService.getDevice();
    const summary: string[] = [];

    for (const param of this.readyWeatherLayers) {
      const layer = this.configService.getLayer(param);
      if (!layer?.slabs || layer.slabs.length === 0) continue;

      const store = new LayerStore(device, {
        layerId: layer.id,
        slabs: layer.slabs,
        timeslots: this.timeslotsPerLayer,
      });
      store.initialize();

      this.layerStores.set(param, store);
      summary.push(`${param.slice(0, 4)}: ${layer.slabs.length}×${this.timeslotsPerLayer}`);
    }

    if (summary.length > 0) {
      console.log(`[Slot] Stores: ${summary.join(', ')}`);
    }
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    this.disposeResizeEffect?.();
    this.disposeResizeEffect = null;
    for (const unsubscribe of this.disposeSubscribes.values()) {
      unsubscribe();
    }
    this.disposeSubscribes.clear();
    for (const ps of this.paramSlots.values()) {
      ps.dispose();
    }
    this.paramSlots.clear();
    for (const store of this.layerStores.values()) {
      store.dispose();
    }
    this.layerStores.clear();
  }
}
