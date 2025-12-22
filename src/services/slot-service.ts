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
import { isWeatherLayer, isWeatherTextureLayer, type TLayer, type TWeatherLayer, type TTimestep, type TimestepOrder, type LayerState } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { RenderService } from './render-service';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import { LayerStore } from './layer-store';
import { BootstrapService } from './bootstrap-service';
import { debounce } from '../utils/debounce';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

const DEBUG = false;

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
    private stateService: StateService,
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
    // slabsCount = number of data fetches (from config params), NOT GPU buffer count
    for (const param of this.readyWeatherLayers) {
      const slabsCount = this.getLayerParams(param).length;
      this.paramSlots.set(param, createParamSlots(param, this.timeslotsPerLayer, slabsCount));
    }

    // Wire up state calculations for all weather layers
    this.renderService.setTempStateFn((time) => this.getState('temp', time));
    this.renderService.setPressureStateFn((time) => this.getState('pressure', time));
    this.renderService.setWindStateFn((time) => this.getState('wind', time));
    this.renderService.setRainStateFn((time) => this.getState('rain', time));
    this.renderService.setCloudsStateFn((time) => this.getState('clouds', time));
    this.renderService.setHumidityStateFn((time) => this.getState('humidity', time));

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

    // Effect: pure computation of wanted state + shader activation (no I/O)
    this.disposeEffect = effect(() => {
      const time = this.stateService.viewState.value.time;
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

        this.optionsService.revertOption('gpu.timeslotsPerLayer', String(lastTimeslots));
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
          const slabsCount = this.getLayerParams(param).length;
          this.paramSlots.set(param, createParamSlots(param, newTimeslots, slabsCount));
        }
      }

      // After shrinking, rebind layers only if active slots are now out of range
      if (!isGrowing) {
        for (const param of this.readyWeatherLayers) {
          const slots = this.renderService.getActiveSlots(param);
          if (slots.slot0 >= newTimeslots || slots.slot1 >= newTimeslots) {
            // Ensure slot 0 buffers exist before rebinding
            this.layerStores.get(param)?.ensureSlotBuffers(0);
            // Active slot is out of range, rebind to slot 0
            this.rebindLayerBuffers(param, 0, 0);
            this.renderService.activateSlots(param, 0, 0, 0);
          }
        }
      }

      this.timeslotsPerLayer = newTimeslots;
      lastTimeslots = newTimeslots;
      this.slotsVersion.value++;
    });
  }

  /** Get Open-Meteo parameter names for a layer from config */
  private getLayerParams(layer: TWeatherLayer): string[] {
    return this.configService.getLayer(layer)?.params ?? [layer];
  }

  /**
   * Expand a single timestep order into per-slab orders.
   * For wind layer: creates 2 orders (U and V components).
   * For other layers: creates 1 order (slab 0).
   */
  private expandOrder(
    url: string,
    param: TWeatherLayer,
    timestep: TTimestep,
    sizeEstimate: number
  ): TimestepOrder[] {
    const omParams = this.getLayerParams(param);
    return omParams.map((omParam, slabIndex) => ({
      url,
      param,
      timestep,
      sizeEstimate: omParams.length > 1 ? sizeEstimate / omParams.length : sizeEstimate,
      slabIndex,
      omParam,
    }));
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

        // Rebind buffers to renderer
        this.rebindLayerBuffers(param, slot.slotIndex, slot.slotIndex);
        this.renderService.activateSlots(param, slot.slotIndex, slot.slotIndex, slot.loadedPoints);
        console.log(`[Slot] ${pcode} activated: ${fmt(ts)}`);
      } else {
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

        // Rebind buffers to renderer
        this.rebindLayerBuffers(param, slot0.slotIndex, slot1.slotIndex);
        this.renderService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        console.log(`[Slot] ${pcode} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        ps.setActiveTimesteps([]);
      }
    }
  }

  /** Rebind layer buffers to renderer (generic for all layer types) */
  private rebindLayerBuffers(param: TWeatherLayer, slotIndex0: number, slotIndex1: number): void {
    const store = this.layerStores.get(param);
    if (!store) return;

    if (isWeatherTextureLayer(param)) {
      const buffer0 = store.getSlotBuffer(slotIndex0, 0);
      const buffer1 = store.getSlotBuffer(slotIndex1, 0);
      if (buffer0 && buffer1) {
        this.renderService.setTextureLayerBuffers(param, buffer0, buffer1);
      } else {
        console.warn(`[Slot] Missing ${param} buffer: slot0=${!!buffer0} slot1=${!!buffer1}`);
      }
    } else if (param === 'wind') {
      // Wind has 2 slabs: U (index 0) and V (index 1)
      const u0 = store.getSlotBuffer(slotIndex0, 0);
      const v0 = store.getSlotBuffer(slotIndex0, 1);
      const u1 = store.getSlotBuffer(slotIndex1, 0);
      const v1 = store.getSlotBuffer(slotIndex1, 1);
      if (u0 && v0 && u1 && v1) {
        this.renderService.setWindLayerBuffers(u0, v0, u1, v1);
      } else {
        console.warn(`[Slot] Missing wind buffers: U0=${!!u0} V0=${!!v0} U1=${!!u1} V1=${!!v1}`);
      }
    }
    // pressure: no buffer rebind needed (uses compute shader)
  }

  /** Upload data to slot via LayerStore */
  private uploadData(param: TWeatherLayer, data: Float32Array, slotIndex: number, slabIndex: number = 0): void {
    const store = this.layerStores.get(param);
    if (!store) return;

    store.writeToSlab(slabIndex, slotIndex, data);

    // Pressure needs regrid after upload (pass the per-slot buffer)
    if (param === 'pressure' && slabIndex === 0) {
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
    const orders: TimestepOrder[] = allOrderTimesteps.flatMap(timestep =>
      this.expandOrder(
        this.timestepService.url(timestep),
        param,
        timestep,
        this.timestepService.getSize(param, timestep)
      )
    );

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
            ps.clearLoading(order.timestep);
            return;
          }

          const currentTime = this.stateService.viewState.value.time;
          const result = ps.allocateSlot(
            order.timestep,
            currentTime,
            (ts) => this.timestepService.toDate(ts)
          );

          if (result) {
            if (result.evicted && result.evictedSlotIndex !== null) {
              this.timestepService.setGpuUnloaded(param, result.evicted);

              // If evicting an active slot, rebind renderer to safe slot first
              const activeSlots = this.renderService.getActiveSlots(param);
              if (activeSlots.slot0 === result.evictedSlotIndex || activeSlots.slot1 === result.evictedSlotIndex) {
                // Ensure slot 0 buffers exist before rebinding
                this.layerStores.get(param)?.ensureSlotBuffers(0);
                this.rebindLayerBuffers(param, 0, 0);
                this.renderService.activateSlots(param, 0, 0, 0);
              }

              // Now safe to destroy evicted slot's buffers
              this.layerStores.get(param)?.destroySlotBuffers(result.evictedSlotIndex);
            }
            // Ensure buffer exists for this slot
            this.layerStores.get(param)?.ensureSlotBuffers(result.slotIndex);

            // Upload to the slab specified in the order
            this.uploadData(param, slice.data, result.slotIndex, order.slabIndex);

            // For single-slab layers: markLoaded immediately
            // For multi-slab layers: markLoaded creates slot, then markSlabLoaded per slab
            const slabsCount = this.getLayerParams(param).length;

            if (slabsCount === 1) {
              // Single-slab: existing behavior
              ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
              this.timestepService.setGpuLoaded(param, order.timestep);
            } else {
              // Multi-slab: track per-slab loading
              const slot = ps.getSlot(order.timestep);
              if (!slot) {
                // First slab: create slot (not loaded yet)
                ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
              }
              ps.markSlabLoaded(order.timestep, order.slabIndex);

              // Check if all slabs are now loaded
              if (ps.areAllSlabsLoaded(result.slotIndex)) {
                this.timestepService.setGpuLoaded(param, order.timestep);
              }
            }

            this.timestepService.refreshCacheState(param);
            this.slotsVersion.value++;
            this.updateShaderIfReady(param, ps);
          } else {
            console.warn(`[Slot] ${P(param)} allocation failed for ${fmt(order.timestep)}`);
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
    if (!wanted) return;
    this.activateIfReady(param, ps, wanted);
  }

  /** Calculate layer state for shader interpolation */
  getState(param: TWeatherLayer, currentTime: Date): LayerState {
    const ps = this.paramSlots.get(param);
    const active = ps?.getActiveTimesteps();

    // No data loaded
    if (!active || active.length === 0) {
      return { mode: 'loading', lerp: 0, time: currentTime };
    }

    const t0 = this.timestepService.toDate(active[0]!).getTime();
    const tc = currentTime.getTime();

    // Single timestep mode - can only render if time matches exactly
    if (active.length === 1) {
      if (tc !== t0) {
        return { mode: 'loading', lerp: 0, time: currentTime };
      }
      return { mode: 'single', lerp: 0, time: currentTime };
    }

    // Pair mode - can only render if time is within range
    const t1 = this.timestepService.toDate(active[1]!).getTime();
    if (tc < t0 || tc > t1) {
      return { mode: 'loading', lerp: 0, time: currentTime };
    }

    const lerp = (tc - t0) / (t1 - t0);
    return { mode: 'pair', lerp, time: currentTime };
  }

  /** @deprecated Use getState instead */
  getLerp(param: TWeatherLayer, currentTime: Date): number {
    const state = this.getState(param, currentTime);
    if (state.mode === 'loading') return -1;
    if (state.mode === 'single') return -2;
    return state.lerp;
  }

  /** Initialize with priority timesteps for all enabled params */
  async initialize(onProgress?: (param: TWeatherLayer, index: number, total: number) => Promise<void>): Promise<void> {
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.stateService.viewState.value.time;
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
        const expanded = this.expandOrder(
          this.timestepService.url(ts),
          param,
          ts,
          this.timestepService.getSize(param, ts)
        );
        allOrders.push(...expanded);
      }
    }

    let completed = 0;
    const total = allOrders.length;

    await this.queueService.submitTimestepOrders(
      allOrders,
      async (order, slice) => {
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

            // Upload to the slab specified in the order
            this.uploadData(order.param, slice.data, result.slotIndex, order.slabIndex);

            // For single-slab layers: markLoaded immediately
            // For multi-slab layers: markLoaded creates slot, then markSlabLoaded per slab
            const slabsCount = this.getLayerParams(order.param).length;

            if (slabsCount === 1) {
              ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
              this.timestepService.setGpuLoaded(order.param, order.timestep);
            } else {
              const slot = ps.getSlot(order.timestep);
              if (!slot) {
                ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
              }
              ps.markSlabLoaded(order.timestep, order.slabIndex);
              if (ps.areAllSlabsLoaded(result.slotIndex)) {
                this.timestepService.setGpuLoaded(order.param, order.timestep);
              }
            }
          }

          completed++;
          await onProgress?.(order.param, completed, total);
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
