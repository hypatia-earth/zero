/**
 * ParamSlotService - Param-centric GPU slot management
 *
 * Key difference from SlotService: slots are keyed by param name (e.g., 'temperature_2m')
 * not layer name (e.g., 'temp'). Multiple layers can share the same param data.
 *
 * This enables:
 * - User layers to get data even when built-in layers are disabled
 * - Multiple layers sharing the same param (e.g., temp + mytemp both use temperature_2m)
 */

import { effect, signal } from '@preact/signals-core';
import { type TWeatherLayer, type TTimestep, type TimestepOrder, type LayerState } from '../config/types';
import type { TimestepService } from './timestep-service';
import type { AuroraService } from './aurora-service';
import type { QueueService } from './queue-service';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { LayerService } from './layer-service';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.slice(0, 4).toUpperCase();

export class ParamSlotService {
  /** Slots keyed by param name (e.g., 'temperature_2m'), not layer name */
  private paramSlots: Map<string, ParamSlots> = new Map();

  private timeslotsPerLayer: number = 8;
  private disposeEffect: (() => void) | null = null;
  private initialized = false;


  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  constructor(
    private timestepService: TimestepService,
    private auroraService: AuroraService,
    private queueService: QueueService,
    private optionsService: OptionsService,
    private stateService: StateService,
    _configService: ConfigService,  // TODO: use for getLayerParams
    private layerService: LayerService,
  ) {
    this.timeslotsPerLayer = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

    // Effect: watch for layer changes, update active params
    let lastActiveParams = '';
    let lastTime = '';

    this.disposeEffect = effect(() => {
      void this.optionsService.options.value; // Subscribe to options changes
      const time = this.stateService.viewState.value.time;
      void this.layerService.changed.value; // Subscribe to registry changes

      if (!this.initialized) return;

      // Collect unique params from all enabled layers
      const newActiveParams = this.collectActiveParams();
      const newActiveParamsStr = [...newActiveParams].sort().join(',');
      const currTime = time.toISOString().slice(11, 16);

      // Diff
      const changes: string[] = [];
      if (lastActiveParams !== newActiveParamsStr) changes.push(`params=${newActiveParamsStr}`);
      if (lastTime !== currTime) changes.push(`time=${lastTime}→${currTime}`);

      if (changes.length === 0) return;
      DEBUG && console.log(`[ParamSlot] ${changes.join(', ')}`);

      lastActiveParams = newActiveParamsStr;
      lastTime = currTime;

      // Ensure ParamSlots exist for all active params
      this.ensureParamSlots(newActiveParams);
      // Track active params:newActiveParams;

      // Update wanted state and activate for each param
      for (const param of newActiveParams) {
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

  /**
   * Collect all unique params from enabled layers (built-in + user)
   */
  private collectActiveParams(): Set<string> {
    const params = new Set<string>();
    const opts = this.optionsService.options.value;

    // Built-in layers
    for (const layer of this.layerService.getBuiltIn()) {
      const layerOpts = opts[layer.id as keyof typeof opts] as { enabled?: boolean } | undefined;
      if (layerOpts?.enabled && layer.params) {
        for (const param of layer.params) {
          params.add(param);
        }
      }
    }

    // User layers
    for (const layer of this.layerService.getUserLayers()) {
      if (this.layerService.isUserLayerEnabled(layer.id) && layer.params) {
        for (const param of layer.params) {
          params.add(param);
        }
      }
    }

    return params;
  }

  /**
   * Ensure ParamSlots instances exist for all needed params
   */
  private ensureParamSlots(params: Set<string>): void {
    for (const param of params) {
      if (!this.paramSlots.has(param)) {
        // Determine slab count (e.g., wind has u+v = 2 slabs, but in param-centric each is separate)
        // In param-centric model, each param is independent, so slabsCount = 1
        this.paramSlots.set(param, createParamSlots(param, this.timeslotsPerLayer, 1));
        DEBUG && console.log(`[ParamSlot] Created slots for param: ${param}`);
      }
    }
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

  /** Calculate ideal load window around time */
  private calculateLoadWindow(time: Date): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

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

  /**
   * Activate shader if required slots are loaded.
   * Sends activateSlots to worker for the param.
   */
  private activateIfReady(param: string, ps: ParamSlots, wanted: WantedState): void {
    const current = ps.getActiveTimesteps();
    const pcode = P(param);

    // Map param to layer for aurora service (temp style for now)
    const layer = this.paramToLayer(param);
    if (!layer) return;

    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;
      const slot = ps.getSlot(ts);
      if (slot?.loaded) {
        if (current.length === 1 && current[0] === ts) return;
        ps.setActiveTimesteps([ts]);

        const t = this.timestepService.toDate(ts).getTime();
        this.auroraService.activateSlots(layer, slot.slotIndex, slot.slotIndex, t, t, slot.loadedPoints);
        DEBUG && console.log(`[ParamSlot] ${pcode} activated: ${fmt(ts)}`);
      } else {
        ps.setActiveTimesteps([]);
      }
    } else {
      const ts0 = wanted.priority[0]!;
      const ts1 = wanted.priority[1]!;
      const slot0 = ps.getSlot(ts0);
      const slot1 = ps.getSlot(ts1);
      if (slot0?.loaded && slot1?.loaded) {
        if (current.length === 2 && current[0] === ts0 && current[1] === ts1) return;
        ps.setActiveTimesteps([ts0, ts1]);

        const t0 = this.timestepService.toDate(ts0).getTime();
        const t1 = this.timestepService.toDate(ts1).getTime();
        this.auroraService.activateSlots(layer, slot0.slotIndex, slot1.slotIndex, t0, t1, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        DEBUG && console.log(`[ParamSlot] ${pcode} activated: ${fmt(ts0)} → ${fmt(ts1)}`);
      } else {
        ps.setActiveTimesteps([]);
      }
    }
  }

  /**
   * Map param name to weather layer (temporary bridge to old aurora API)
   * TODO: Aurora should accept params directly
   */
  private paramToLayer(param: string): TWeatherLayer | null {
    // Map common params to their original layer names
    const paramLayerMap: Record<string, TWeatherLayer> = {
      'temperature_2m': 'temp',
      'precipitation': 'rain',
      'pressure_msl': 'pressure',
      'wind_u_10m': 'wind',
      'wind_v_10m': 'wind',
      'cloud_cover': 'clouds',
      'relative_humidity_2m': 'humidity',
    };
    return paramLayerMap[param] ?? null;
  }

  /**
   * Receive and process downloaded data for a param/timestep.
   * Called by QueueService when data download completes.
   */
  receiveData(param: string, timestep: TTimestep, slabIndex: number, data: Float32Array): boolean {
    DEBUG && console.log(`[ParamSlot] receiveData: ${param} ${timestep} slab=${slabIndex}`);

    const ps = this.paramSlots.get(param);
    if (!ps) {
      DEBUG && console.log(`[ParamSlot] No slots for param: ${param}`);
      return false;
    }

    // Skip if timestep no longer in wanted window
    if (!ps.wanted.value?.window.includes(timestep)) {
      ps.clearLoading(timestep);
      DEBUG && console.log(`[ParamSlot] ${P(param)} skip ${fmt(timestep)} (unwanted)`);
      return false;
    }

    const currentTime = this.stateService.viewState.value.time;
    const result = ps.allocateSlot(
      timestep,
      currentTime,
      (ts) => this.timestepService.toDate(ts)
    );

    if (!result) {
      console.warn(`[ParamSlot] ${P(param)} allocation failed for ${fmt(timestep)}`);
      return false;
    }

    // Handle eviction
    if (result.evicted) {
      this.timestepService.setGpuUnloaded(this.paramToLayer(param) ?? param as TWeatherLayer, result.evicted);
    }

    // Upload to worker
    const layer = this.paramToLayer(param);
    if (layer) {
      this.auroraService.uploadData(layer, result.slotIndex, slabIndex, data);
    }

    // Mark loaded
    ps.markLoaded(timestep, result.slotIndex, data.length);
    if (layer) {
      this.timestepService.setGpuLoaded(layer, timestep);
      this.timestepService.setCached(layer, timestep, data.byteLength);
    }

    this.slotsVersion.value++;
    this.updateShaderIfReady(param, ps);
    ps.clearLoading(timestep);

    return true;
  }

  /** Update shader when a slot finishes loading */
  private updateShaderIfReady(param: string, ps: ParamSlots): void {
    const wanted = ps.wanted.value;
    if (!wanted) return;
    this.activateIfReady(param, ps, wanted);
  }

  /** Calculate layer state for shader interpolation */
  getState(param: string, currentTime: Date): LayerState {
    const ps = this.paramSlots.get(param);
    const active = ps?.getActiveTimesteps();

    if (!active || active.length === 0) {
      return { mode: 'loading', lerp: 0, time: currentTime };
    }

    const t0 = this.timestepService.toDate(active[0]!).getTime();
    const tc = currentTime.getTime();

    if (active.length === 1) {
      if (tc !== t0) {
        return { mode: 'loading', lerp: 0, time: currentTime };
      }
      return { mode: 'single', lerp: 0, time: currentTime };
    }

    const t1 = this.timestepService.toDate(active[1]!).getTime();
    if (tc < t0 || tc > t1) {
      return { mode: 'loading', lerp: 0, time: currentTime };
    }

    const lerp = (tc - t0) / (t1 - t0);
    return { mode: 'pair', lerp, time: currentTime };
  }

  /** Initialize with priority timesteps for all active params */
  async initialize(onProgress?: (param: string, index: number, total: number) => Promise<void>): Promise<void> {
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();

    const time = this.stateService.viewState.value.time;

    // Collect active params
    const activeParams = this.collectActiveParams();
    if (activeParams.size === 0) {
      this.initialized = true;
      DEBUG && console.log('[ParamSlot] Initialized (no params active)');
      return;
    }

    // Ensure slots exist
    this.ensureParamSlots(activeParams);
    // Track active params:activeParams;

    // Build orders for all active params
    const allOrders: TimestepOrder[] = [];
    const wantedByParam = new Map<string, WantedState>();

    for (const param of activeParams) {
      const ps = this.paramSlots.get(param)!;
      const wanted = this.computeWanted(time);
      wantedByParam.set(param, wanted);

      DEBUG && console.log(`[ParamSlot] ${P(param)} init ${wanted.mode}: ${wanted.priority.map(fmt).join(', ')}`);

      const layer = this.paramToLayer(param);
      if (!layer) continue;

      for (const ts of wanted.priority) {
        ps.setLoading([ts]);
        allOrders.push({
          url: this.timestepService.url(ts),
          param: layer,
          timestep: ts,
          sizeEstimate: this.timestepService.getSize(layer, ts),
          slabIndex: 0,
          omParam: param,
        });
      }
    }

    const total = allOrders.length;
    let orderIndex = 0;

    if (onProgress && allOrders.length > 0) {
      await onProgress(allOrders[0]!.param, 0, total);
    }

    await this.queueService.submitTimestepOrders(
      allOrders,
      async (order, slice) => {
        if (slice.done) {
          const param = order.omParam!;
          const ps = this.paramSlots.get(param)!;
          const result = ps.allocateSlot(
            order.timestep,
            time,
            (ts) => this.timestepService.toDate(ts)
          );

          if (result) {
            this.auroraService.uploadData(order.param, result.slotIndex, order.slabIndex, slice.data);
            ps.markLoaded(order.timestep, result.slotIndex, slice.data.length);
          }

          orderIndex++;
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

    // Activate for all params
    for (const param of activeParams) {
      const ps = this.paramSlots.get(param)!;
      const wanted = wantedByParam.get(param)!;
      ps.wanted.value = wanted;
      this.activateIfReady(param, ps, wanted);
    }

    this.initialized = true;
    this.slotsVersion.value++;
    DEBUG && console.log('[ParamSlot] Initialized');
  }

  /** Get active timesteps for a param */
  getActiveTimesteps(param: string): TTimestep[] {
    return this.paramSlots.get(param)?.getActiveTimesteps() ?? [];
  }

  /** Get wanted window (first active param's window, or empty) */
  getWantedWindow(): TTimestep[] {
    for (const [, ps] of this.paramSlots) {
      return ps.wanted.value?.window ?? [];
    }
    return [];
  }

  /** GPU memory stats signal from worker */
  get memoryStats() {
    return this.auroraService.memoryStats;
  }

  /** Set Gaussian LUTs for synthetic data generation */
  /** Set Gaussian LUTs for synthetic data generation (TODO: implement) */
  setGaussianLats(_lats: Float32Array): void {
    // TODO: implement synthetic data support
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    for (const ps of this.paramSlots.values()) {
      ps.dispose();
    }
    this.paramSlots.clear();
  }
}
