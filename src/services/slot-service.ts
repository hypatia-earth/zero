/**
 * SlotService - GPU slot management and shader activation
 *
 * Manages ParamSlots instances (one per weather layer) and LayerStores for GPU buffers.
 * Handles: shader activation on time change, data receipt from QueueService.
 * QueueService drives data fetching; SlotService manages where data goes.
 */

import { effect, signal } from '@preact/signals-core';
import { isWeatherLayer, type TLayer, type TWeatherLayer, type TTimestep, type TimestepOrder, type LayerState } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { AuroraProxy } from './aurora-proxy';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';
import { generateSyntheticO1280Pressure } from '../utils/synthetic-pressure';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TWeatherLayer) => param.slice(0, 4).toUpperCase();



export class SlotService {
  private paramSlots: Map<TWeatherLayer, ParamSlots> = new Map();
  private readyLayers: TLayer[] = [];
  private readyWeatherLayers: TWeatherLayer[] = [];
  private timeslotsPerLayer: number = 8;
  private disposeEffect: (() => void) | null = null;
  private initialized = false;
  private syntheticDataCache = new Map<TWeatherLayer, Float32Array>();

  // Gaussian grid lookup tables (for synthetic data generation)
  private gaussianLats: Float32Array | null = null;

  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  constructor(
    private timestepService: TimestepService,
    private auroraProxy: AuroraProxy,
    private queueService: QueueService,
    private optionsService: OptionsService,
    private stateService: StateService,
    private configService: ConfigService,
  ) {
    // All layers use per-slot buffers with rebinding - no binding size limit
    // Only limited by total VRAM (handled by OOM on allocation)
    this.timeslotsPerLayer = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);
    this.readyLayers = this.configService.getReadyLayers();
    this.readyWeatherLayers = this.readyLayers.filter(isWeatherLayer);
    DEBUG && console.log(`[Slot] ${this.timeslotsPerLayer} timeslots for: ${this.readyWeatherLayers.join(', ')}`);

    // Create ParamSlots for each slot-based layer
    // slabsCount = number of data fetches (from config params), NOT GPU buffer count
    // Note: LayerStores are created in the worker, not here
    for (const param of this.readyWeatherLayers) {
      const slabsCount = this.getLayerParams(param).length;
      this.paramSlots.set(param, createParamSlots(param, this.timeslotsPerLayer, slabsCount));
    }

    // Single effect: listen to options, compare what changed, act accordingly
    let last = { time: '', slots: 0, layers: '' };
    this.disposeEffect = effect(() => {
      const opts = this.optionsService.options.value;
      const time = this.stateService.viewState.value.time;
      const newTimeslots = parseInt(opts.gpu.timeslotsPerLayer, 10);
      const enabledLayers = this.readyWeatherLayers.filter(p => opts[p].enabled);

      if (!this.initialized) return;

      // Build current state and diff
      const curr = {
        time: time.toISOString().slice(11, 16),
        slots: newTimeslots,
        layers: enabledLayers.join(','),
      };
      const changes: string[] = [];
      if (last.time !== curr.time) changes.push(`time=${last.time}→${curr.time}`);
      if (last.slots !== curr.slots) changes.push(`slots=${last.slots}→${curr.slots}`);
      if (last.layers !== curr.layers) changes.push(`layers=${last.layers}→${curr.layers}`);

      if (changes.length === 0) return; // Nothing changed
      DEBUG && console.log(`[SlotParams] ${changes.join(', ')}`);

      // --- RESIZE HANDLING (if slots changed) ---
      const lastTimeslots = last.slots || this.timeslotsPerLayer;
      last = curr; // Update AFTER reading lastTimeslots
      if (newTimeslots !== lastTimeslots) {
        this.queueService.clearTasks();

        // Update ParamSlots capacity
        // Note: Worker manages GPU buffer resize internally
        const isGrowing = newTimeslots > lastTimeslots;
        const toDate = (ts: TTimestep) => this.timestepService.toDate(ts);

        for (const param of this.readyWeatherLayers) {
          if (isGrowing) {
            this.paramSlots.get(param)?.grow(newTimeslots);
          } else {
            // Smart shrink: get current mapping from ParamSlots
            const ps = this.paramSlots.get(param);
            const currentMapping = ps?.getTimeslotMapping() ?? new Map();

            // Sort by distance from current time, keep closest N
            const sorted = [...currentMapping.entries()].sort((a, b) => {
              const distA = Math.abs(toDate(a[0]).getTime() - time.getTime());
              const distB = Math.abs(toDate(b[0]).getTime() - time.getTime());
              return distA - distB;
            });
            const keptEntries = sorted.slice(0, newTimeslots);
            const keptMapping = new Map(keptEntries.map(([ts], i) => [ts, i])); // Renumber to 0..N-1

            // Sync ParamSlots
            ps?.shrink(newTimeslots, keptMapping);

            // Update timestepService GPU state
            this.timestepService.setGpuState(param, new Set(keptMapping.keys()));

            // Force re-activation by clearing active timesteps (slot indices changed)
            ps?.setActiveTimesteps([]);
            this.deactivateLayer(param);
          }
        }

        this.timeslotsPerLayer = newTimeslots;
        this.slotsVersion.value++;
      }

      // --- WANTED STATE + SHADER ACTIVATION ---
      for (const param of enabledLayers) {
        const ps = this.paramSlots.get(param)!;
        const wanted = this.computeWanted(time);
        this.activateIfReady(param, ps, wanted);

        const prev = ps.wanted.value;
        if (!prev || prev.priority.join() !== wanted.priority.join()) {
          ps.wanted.value = wanted;
        }
      }
    });
  }

  /** Get Open-Meteo parameter names for a layer from config */
  private getLayerParams(layer: TWeatherLayer): string[] {
    return this.configService.getLayer(layer)?.params ?? [layer];
  }

  /** Check if layer uses synthetic test data (from config) */
  private usesSynthData(layer: TWeatherLayer): boolean {
    return this.configService.getLayer(layer)?.useSynthData === true;
  }

  /** Get or generate synthetic data for a layer (cached) */
  private getSyntheticData(layer: TWeatherLayer): Float32Array {
    let data = this.syntheticDataCache.get(layer);
    if (data) return data;

    if (!this.gaussianLats) {
      throw new Error(`Cannot generate synthetic data: gaussianLats not available`);
    }
    const gaussianLats = this.gaussianLats;

    if (layer === 'pressure') {
      data = generateSyntheticO1280Pressure(gaussianLats);
    } else {
      throw new Error(`No synthetic data generator for layer: ${layer}`);
    }

    console.log(`[Slot] Generated synthetic data for ${layer}: ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
    this.syntheticDataCache.set(layer, data);
    return data;
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
  private computeWanted(time: Date): WantedState {
    const exactTs = this.timestepService.getExactTimestep(time);
    const window = this.calculateLoadWindow(time);

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

        // Worker handles buffer rebinding on activateSlots
        this.auroraProxy.activateSlots(param, slot.slotIndex, slot.slotIndex, 0, slot.loadedPoints);
        DEBUG && console.log(`[Slot] ${pcode} activated: ${fmt(ts)}`);
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

        // Worker handles buffer rebinding on activateSlots
        const lerp = 0;  // Lerp computed by worker from time
        this.auroraProxy.activateSlots(param, slot0.slotIndex, slot1.slotIndex, lerp, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        DEBUG && console.log(`[Slot] ${pcode} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        ps.setActiveTimesteps([]);
      }
    }
  }

  /** Deactivate layer by setting slots to 0 with 0 points */
  private deactivateLayer(param: TWeatherLayer): void {
    // Worker handles buffer rebinding on activateSlots
    this.auroraProxy.activateSlots(param, 0, 0, 0);
  }

  /** Upload data to slot via worker message */
  private uploadData(param: TWeatherLayer, timestep: TTimestep, data: Float32Array, slotIndex: number, slabIndex: number = 0): void {
    // Swap with synthetic data if configured
    if (this.usesSynthData(param)) {
      data = this.getSyntheticData(param);
    }

    // Send data to worker (transfers ownership of buffer)
    this.auroraProxy.uploadData(param, timestep, slotIndex, slabIndex, data);

    // Pressure needs regrid after upload
    if (param === 'pressure' && slabIndex === 0) {
      this.auroraProxy.triggerPressureRegrid(slotIndex);
    }
  }

  /**
   * Upload data and mark slot as loaded.
   * Handles both single-slab and multi-slab layers.
   * Returns true if all slabs for this timestep are now loaded.
   */
  private uploadAndMarkLoaded(
    param: TWeatherLayer,
    timestep: TTimestep,
    slotIndex: number,
    slabIndex: number,
    data: Float32Array
  ): boolean {
    const ps = this.paramSlots.get(param);
    if (!ps) return false;

    // Upload to worker (worker manages GPU buffers)
    this.uploadData(param, timestep, data, slotIndex, slabIndex);

    // Mark loaded (handle multi-slab)
    const slabsCount = this.getLayerParams(param).length;

    if (slabsCount === 1) {
      ps.markLoaded(timestep, slotIndex, data.length);
      this.timestepService.setGpuLoaded(param, timestep);
      return true;
    } else {
      const slot = ps.getSlot(timestep);
      if (!slot) {
        ps.markLoaded(timestep, slotIndex, data.length);
      }
      ps.markSlabLoaded(timestep, slabIndex);

      if (ps.areAllSlabsLoaded(slotIndex)) {
        this.timestepService.setGpuLoaded(param, timestep);
        return true;
      }
      return false;
    }
  }

  /** Calculate ideal load window around time */
  private calculateLoadWindow(time: Date): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    // Use options value directly to stay in sync with QS
    const numSlots = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

    while (window.length < numSlots) {
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

  /** Update shader when a slot finishes loading */
  private updateShaderIfReady(param: TWeatherLayer, ps: ParamSlots): void {
    const wanted = ps.wanted.value;
    if (!wanted) return;
    this.activateIfReady(param, ps, wanted);
  }

  /**
   * Receive and process downloaded data for a timestep.
   * Called by QueueService when data download completes.
   * Returns true if data was accepted and processed, false if rejected (e.g., unwanted timestep).
   */
  receiveData(layer: TWeatherLayer, timestep: TTimestep, slabIndex: number, data: Float32Array): boolean {
    DEBUG && console.log(`[Slot] receiveData: ${layer} ${timestep} slab=${slabIndex}`);
    const ps = this.paramSlots.get(layer);
    if (!ps) return false;

    // Skip if timestep no longer in wanted window
    if (!ps.wanted.value?.window.includes(timestep)) {
      ps.clearLoading(timestep);
      DEBUG && console.log(`[Slot] ${P(layer)} skip ${fmt(timestep)} (unwanted)`);
      return false;
    }

    const currentTime = this.stateService.viewState.value.time;
    const result = ps.allocateSlot(
      timestep,
      currentTime,
      (ts) => this.timestepService.toDate(ts)
    );

    if (!result) {
      console.warn(`[Slot] ${P(layer)} allocation failed for ${fmt(timestep)}`);
      return false;
    }

    // Handle eviction - deactivate if evicted slot was active
    if (result.evicted && result.evictedSlotIndex !== null) {
      this.timestepService.setGpuUnloaded(layer, result.evicted);
      // Check if evicted slot was in use by looking at active timesteps
      const activeTs = ps.getActiveTimesteps();
      const evictedWasActive = activeTs.some(ts => {
        const slot = ps.getSlot(ts);
        return slot?.slotIndex === result.evictedSlotIndex;
      });
      if (evictedWasActive) {
        this.deactivateLayer(layer);
      }
    }

    // Upload and mark loaded
    this.uploadAndMarkLoaded(layer, timestep, result.slotIndex, slabIndex, data);
    this.timestepService.setCached(layer, timestep, data.byteLength);
    this.slotsVersion.value++;
    this.updateShaderIfReady(layer, ps);
    ps.clearLoading(timestep);

    return true;
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

  /** Initialize with priority timesteps for all enabled params */
  async initialize(onProgress?: (param: TWeatherLayer, index: number, total: number) => Promise<void>): Promise<void> {
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.stateService.viewState.value.time;
    const opts = this.optionsService.options.value;

    const enabledParams = this.readyWeatherLayers.filter(p => opts[p].enabled);
    if (enabledParams.length === 0) {
      this.initialized = true;
      DEBUG && console.log('[Slot] Initialized (no layers enabled)');
      return;
    }

    // Build orders for all enabled params (synthetic swap happens at upload time)
    const allOrders: TimestepOrder[] = [];
    const wantedByParam = new Map<TWeatherLayer, WantedState>();

    for (const param of enabledParams) {
      const ps = this.paramSlots.get(param)!;
      const wanted = this.computeWanted(time);
      wantedByParam.set(param, wanted);

      DEBUG && console.log(`[Slot] ${P(param)} init ${wanted.mode}: ${wanted.priority.map(fmt).join(', ')}`);

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

    const total = allOrders.length;
    let orderIndex = 0;

    // Prospective: announce first order BEFORE any downloading starts
    if (onProgress && allOrders.length > 0) {
      await onProgress(allOrders[0]!.param, 0, total);
    }

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
            this.uploadAndMarkLoaded(order.param, order.timestep, result.slotIndex, order.slabIndex, slice.data);
          }

          orderIndex++;
          // Prospective: announce NEXT order (what's about to load)
          const nextOrder = allOrders[orderIndex];
          if (nextOrder && onProgress) {
            await onProgress(nextOrder.param, orderIndex, total);
          }
        }
      },
      (order, actualBytes) => {
        this.timestepService.setSize(order.param, order.timestep, actualBytes);
      }
    );

    // Activate shaders for all layers
    for (const param of enabledParams) {
      const ps = this.paramSlots.get(param)!;
      const wanted = wantedByParam.get(param)!;
      ps.wanted.value = wanted;
      this.activateIfReady(param, ps, wanted);
    }

    this.initialized = true;
    this.slotsVersion.value++;
    DEBUG && console.log('[Slot] Initialized');
  }

  /** Get active timesteps for a param (0, 1, or 2 items) */
  getActiveTimesteps(param: TWeatherLayer): TTimestep[] {
    return this.paramSlots.get(param)?.getActiveTimesteps() ?? [];
  }

  /** Get wanted window (first enabled param's window, or empty) */
  getWantedWindow(): TTimestep[] {
    for (const [param, ps] of this.paramSlots) {
      if (this.optionsService.options.value[param].enabled) {
        return ps.wanted.value?.window ?? [];
      }
    }
    return [];
  }

  /** Get GPU memory stats across all layer stores */
  getMemoryStats(): {
    allocatedMB: number;
    capacityMB: number;
    layers: Map<string, { allocatedMB: number; capacityMB: number }>;
  } {
    // Stats now tracked by worker - return placeholder
    // TODO: Add message to query worker stats
    return {
      allocatedMB: 0,
      capacityMB: 0,
      layers: new Map(),
    };
  }

  /** Set Gaussian LUTs for synthetic data generation */
  setGaussianLats(lats: Float32Array): void {
    this.gaussianLats = lats;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    for (const ps of this.paramSlots.values()) {
      ps.dispose();
    }
    this.paramSlots.clear();
    // Worker manages GPU buffer disposal
  }
}
