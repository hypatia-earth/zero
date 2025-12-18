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
import type { ConfigService } from './config-service';
import { LayerStore } from './layer-store';
import { BootstrapService } from './bootstrap-service';
import { debounce } from '../utils/debounce';

const DEBUG = false;
const DEBUG_MONKEY = false;
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: TParam) => param.slice(0, 4).toUpperCase();

/** Params that use slot-based loading */
const SLOT_PARAMS: TParam[] = ['temp', 'pressure'];

export class SlotService {
  private paramSlots: Map<TParam, ParamSlots> = new Map();
  private layerStores: Map<TParam, LayerStore> = new Map();
  private maxSlotsPerParam: number = 8;
  private disposeEffect: (() => void) | null = null;
  private disposeResizeEffect: (() => void) | null = null;
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
    private optionsService: OptionsService,
    private configService: ConfigService,
  ) {
    // Get requested slots - GPU limits vary by architecture:
    // - Legacy layers (pressure): capped by min(maxBufferSize, maxStorageBufferBindingSize) ~201MB
    // - Per-slot layers (temp): use rebinding, only limited by total VRAM
    const requestedSlots = this.renderService.getMaxSlotsPerLayer();
    const device = this.renderService.getDevice();
    const maxBufferBytes = device.limits.maxBufferSize;
    const maxBindingBytes = device.limits.maxStorageBufferBindingSize;
    const legacyMaxBytes = Math.min(maxBufferBytes, maxBindingBytes);  // Legacy layers need both
    const legacyMaxMB = Math.floor(legacyMaxBytes / 1024 / 1024);
    const maxSlabMB = 26;  // Largest slab size (temp, pressure raw)
    const maxSlotsLegacy = Math.floor(legacyMaxMB / maxSlabMB);
    this.maxSlotsPerParam = Math.min(requestedSlots, maxSlotsLegacy);

    const bufferMB = Math.floor(maxBufferBytes / 1024 / 1024);
    const bindingMB = Math.floor(maxBindingBytes / 1024 / 1024);
    console.log(`[Slot] GPU: bufferMB=${bufferMB}, bindingMB=${bindingMB}, legacyMax=${legacyMaxMB}MB (${maxSlotsLegacy} slots), requested=${requestedSlots}`);
    console.log(`[Slot] Per-slot layers (temp): rebind architecture, no binding limit`);

    if (this.maxSlotsPerParam < requestedSlots) {
      console.warn(`[Slot] Legacy layers capped: ${requestedSlots} → ${this.maxSlotsPerParam} timeslots (binding limit: ${legacyMaxMB} MB)`);
    }

    // Create LayerStores for weather layers with slab definitions
    this.initializeLayerStores();

    // Create ParamSlots for each slot-based layer
    for (const param of SLOT_PARAMS) {
      this.paramSlots.set(param, createParamSlots(param, this.maxSlotsPerParam));
    }

    // Wire up lerp calculations
    this.renderService.setTempLerpFn((time) => this.getLerp('temp', time));
    this.renderService.setPressureLerpFn((time) => this.getLerp('pressure', time));

    // Wire up data-ready functions for each slot-based param
    for (const param of SLOT_PARAMS) {
      this.renderService.setDataReadyFn(param, () => this.getActivePair(param) !== null);
    }

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

    // Effect: resize LayerStores when timeslotsPerLayer option changes
    let lastTimeslots = this.maxSlotsPerParam;
    this.disposeResizeEffect = effect(() => {
      const requestedTimeslots = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);
      const device = this.renderService.getDevice();
      const effectiveMaxBytes = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
      const effectiveMaxMB = Math.floor(effectiveMaxBytes / 1024 / 1024);
      const maxSlabMB = 26;
      const maxFromGpu = Math.floor(effectiveMaxMB / maxSlabMB);
      const newTimeslots = Math.min(requestedTimeslots, maxFromGpu);

      if (newTimeslots === lastTimeslots) return;

      console.log(`[Slot] Resizing stores: ${lastTimeslots} → ${newTimeslots} timeslots`);

      // Try resize all LayerStores - rollback on any failure
      const resizedStores: TParam[] = [];
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

      // Update ParamSlots capacity (recreate with new size)
      for (const param of SLOT_PARAMS) {
        const oldPs = this.paramSlots.get(param);
        oldPs?.dispose();
        this.paramSlots.set(param, createParamSlots(param, newTimeslots));
      }

      // Rewire LayerStore buffers to GlobeRenderer (new buffers after resize)
      this.wireLayerBuffers();

      this.maxSlotsPerParam = newTimeslots;
      lastTimeslots = newTimeslots;
      this.slotsVersion.value++;
    });
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
   * Skips if already activated with same pair (avoids redundant GPU updates).
   */
  private activateIfReady(param: TParam, ps: ParamSlots, wanted: WantedState): void {
    const current = ps.getActivePair();
    const pcode = P(param);

    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;
      const slot = ps.getSlot(ts);
      if (slot?.loaded) {
        // Skip if already activated with same timestep
        if (current?.t0 === ts && current.t1 === null) {
          DEBUG && console.log(`[Slot] ${pcode} skip (same): ${fmt(ts)}`);
          return;
        }
        ps.setActivePair({ t0: ts, t1: null });

        // Rebind temp buffers (per-slot mode)
        if (param === 'temp') {
          this.rebindTempBuffers(slot.slotIndex, slot.slotIndex);
        }

        this.renderService.activateSlots(param, slot.slotIndex, slot.slotIndex, slot.loadedPoints);
        console.log(`[Slot] ${pcode} activated: ${fmt(ts)}`);
      } else {
        DEBUG_MONKEY && console.log(`[Monkey] ${pcode} CANNOT activate single ${fmt(ts)}: slot=${!!slot} loaded=${slot?.loaded}`);
        ps.setActivePair(null);
      }
    } else {
      const t0 = wanted.priority[0]!;
      const t1 = wanted.priority[1]!;
      const slot0 = ps.getSlot(t0);
      const slot1 = ps.getSlot(t1);
      if (slot0?.loaded && slot1?.loaded) {
        // Skip if already activated with same pair
        if (current?.t0 === t0 && current?.t1 === t1) {
          DEBUG && console.log(`[Slot] ${pcode} skip (same): ${fmt(t0)} → ${fmt(t1)}`);
          return;
        }
        ps.setActivePair({ t0, t1 });

        // Rebind temp buffers (per-slot mode)
        if (param === 'temp') {
          this.rebindTempBuffers(slot0.slotIndex, slot1.slotIndex);
        }

        this.renderService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        console.log(`[Slot] ${pcode} activated: ${fmt(t0)} → ${fmt(t1)}`);
      } else {
        DEBUG_MONKEY && console.log(`[Monkey] ${pcode} CANNOT activate pair ${fmt(t0)}→${fmt(t1)}: slot0=${!!slot0}/${slot0?.loaded} slot1=${!!slot1}/${slot1?.loaded}`);
        ps.setActivePair(null);
      }
    }
  }

  /** Rebind temp slot buffers to renderer (per-slot mode) */
  private rebindTempBuffers(slotIndex0: number, slotIndex1: number): void {
    const store = this.layerStores.get('temp');
    if (!store || !store.usePerSlotBuffers) return;

    const buffer0 = store.getSlotBuffer(slotIndex0, 0);  // slab 0 = temp data
    const buffer1 = store.getSlotBuffer(slotIndex1, 0);

    if (buffer0 && buffer1) {
      this.renderService.setTempSlotBuffers(buffer0, buffer1);
      console.log(`[Slot] Temp buffers rebound: slots ${slotIndex0}, ${slotIndex1}`);
    } else {
      console.warn(`[Slot] Missing temp buffer: slot0=${!!buffer0} slot1=${!!buffer1}`);
    }
  }

  /** Upload data to slot - routes to LayerStore (per-slot) or RenderService (legacy) */
  private uploadData(param: TParam, data: Float32Array, slotIndex: number): void {
    const store = this.layerStores.get(param);

    if (store?.usePerSlotBuffers) {
      // Per-slot mode: write directly to LayerStore
      store.writeToSlab(0, slotIndex, data);  // slab 0 for single-slab layers
    } else {
      // Legacy mode: use RenderService (pressure, etc.)
      this.renderService.uploadToSlot(param, data, slotIndex);
    }
  }

  /** Fetch missing timesteps */
  private fetchMissing(param: TParam, ps: ParamSlots, wanted: WantedState): void {
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
              // Per-slot mode: destroy evicted slot's buffers
              const store = this.layerStores.get(param);
              if (store?.usePerSlotBuffers) {
                store.destroySlotBuffers(result.evictedSlotIndex);
              }
            }
            // Per-slot mode: ensure buffer exists for this slot
            const store = this.layerStores.get(param);
            if (store?.usePerSlotBuffers) {
              store.ensureSlotBuffers(result.slotIndex);
            }
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
  private updateShaderIfReady(param: TParam, ps: ParamSlots): void {
    const wanted = ps.wanted.value;
    if (!wanted) {
      DEBUG_MONKEY && console.warn(`[Monkey] ${P(param)} updateShaderIfReady: wanted is NULL!`);
      return;
    }
    DEBUG_MONKEY && console.log(`[Monkey] ${P(param)} updateShaderIfReady: wanted=${wanted.mode} [${wanted.priority.map(fmt).join(', ')}]`);
    this.activateIfReady(param, ps, wanted);
  }

  /** Calculate lerp for shader interpolation */
  getLerp(param: TParam, currentTime: Date): number {
    const ps = this.paramSlots.get(param);
    const pair = ps?.getActivePair();
    if (!pair) return -1;

    if (pair.t1 === null) return -2;  // Single slot mode

    const t0 = this.timestepService.toDate(pair.t0).getTime();
    const t1 = this.timestepService.toDate(pair.t1).getTime();
    const tc = currentTime.getTime();

    if (tc < t0 || tc > t1) return -1;
    return (tc - t0) / (t1 - t0);
  }

  /** @deprecated Use getLerp('temp', time) */
  getTempLerp(currentTime: Date): number {
    return this.getLerp('temp', currentTime);
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
            // Per-slot mode: ensure buffer exists for this slot
            const store = this.layerStores.get(order.param);
            if (store?.usePerSlotBuffers) {
              store.ensureSlotBuffers(result.slotIndex);
            }
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

  /** Get active pair for a param */
  getActivePair(param: TParam): { t0: TTimestep; t1: TTimestep | null } | null {
    return this.paramSlots.get(param)?.getActivePair() ?? null;
  }

  /** Get LayerStore for a param */
  getLayerStore(param: TParam): LayerStore | undefined {
    return this.layerStores.get(param);
  }

  /** Initialize LayerStores for weather layers with slab definitions */
  private initializeLayerStores(): void {
    const device = this.renderService.getDevice();
    const layers = this.configService.getLayers();

    for (const layer of layers) {
      // Only create stores for layers with slab definitions
      if (!layer.slabs || layer.slabs.length === 0) continue;

      // Temp uses per-slot buffers for rebinding (unlimited slots)
      const usePerSlotBuffers = layer.id === 'temp';

      const store = new LayerStore(device, {
        layerId: layer.id,
        slabs: layer.slabs,
        maxTimeslots: this.maxSlotsPerParam,
        usePerSlotBuffers,
      });
      store.initialize();

      this.layerStores.set(layer.id as TParam, store);
      const mode = usePerSlotBuffers ? 'per-slot' : 'legacy';
      console.log(`[Slot] Created LayerStore: ${layer.id} (${layer.slabs.length} slabs, ${this.maxSlotsPerParam} timeslots, ${mode})`);
    }

    // Wire LayerStore buffers to GlobeRenderer
    this.wireLayerBuffers();
  }

  /** Pass LayerStore buffers to GlobeRenderer (replaces internal buffers) */
  private wireLayerBuffers(): void {
    // Temp layer: per-slot mode - buffers created/rebound dynamically via rebindTempBuffers()
    // No initial wiring needed; first rebind happens when first pair is activated

    // Pressure layer: 'raw' slab (first of 2) - legacy mode
    const pressureStore = this.layerStores.get('pressure');
    if (pressureStore) {
      const buffers = pressureStore.getBuffers();
      if (buffers.length > 0) {
        this.renderService.setPressureDataBuffer(buffers[0]!);
      }
    }

    // TODO: Wire other layers (rain, clouds, humidity, wind) when implemented
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
