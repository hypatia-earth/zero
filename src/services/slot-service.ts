/**
 * SlotService - Param-centric GPU slot management
 *
 * Slots are keyed by param name (e.g., 'temperature_2m'),
 * not layer name (e.g., 'temp'). Multiple layers can share the same param data.
 *
 * This enables:
 * - User layers to get data even when built-in layers are disabled
 * - Multiple layers sharing the same param (e.g., temp + mytemp both use temperature_2m)
 */

import { effect, signal } from '@preact/signals-core';
import { type TTimestep, type TimestepOrder, type LayerState } from '../config/types';
import type { TimestepService } from './timestep/timestep-service';
import type { AuroraService } from './aurora-service';
import type { QueueService } from './queue/queue-service';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { LayerService } from './layer/layer-service';
import { createParamSlots, type ParamSlots, type WantedState } from './param-slots';

const DEBUG = false;

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.replace(/_/g, '').slice(0, 5).toUpperCase();

export class SlotService {
  /** Slots keyed by param name (e.g., 'temperature_2m'), not layer name */
  private paramSlots: Map<string, ParamSlots> = new Map();

  /** Params in test mode - ignore real data from queue */
  private testModeParams: Set<string> = new Set();

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

    // Effect: watch for layer/options/time changes, update active params and resize slots
    let lastActiveParams = '';
    let lastTime = '';
    let lastTimeslots = this.timeslotsPerLayer;

    this.disposeEffect = effect(() => {
      const opts = this.optionsService.options.value;
      const time = this.stateService.viewState.value.time;
      void this.layerService.changed.value; // Subscribe to registry changes

      if (!this.initialized) return;

      const newTimeslots = parseInt(opts.gpu.timeslotsPerLayer, 10);
      const newActiveParams = this.collectActiveParams();
      const newActiveParamsStr = [...newActiveParams].sort().join(',');
      const currTime = time.toISOString().slice(11, 16);

      // Diff
      const changes: string[] = [];
      if (lastActiveParams !== newActiveParamsStr) changes.push(`params=${newActiveParamsStr}`);
      if (lastTime !== currTime) changes.push(`time=${lastTime}→${currTime}`);
      if (lastTimeslots !== newTimeslots) changes.push(`slots=${lastTimeslots}→${newTimeslots}`);

      if (changes.length === 0) return;
      DEBUG && console.log(`[ParamSlot] ${changes.join(', ')}`);

      const prevTimeslots = lastTimeslots;
      lastActiveParams = newActiveParamsStr;
      lastTime = currTime;
      lastTimeslots = newTimeslots;

      // --- RESIZE HANDLING (if timeslotsPerLayer changed) ---
      if (newTimeslots !== prevTimeslots) {
        this.queueService.clearTasks();
        const isGrowing = newTimeslots > prevTimeslots;
        const toDate = (ts: TTimestep) => this.timestepService.toDate(ts);

        for (const [param, ps] of this.paramSlots) {
          if (isGrowing) {
            ps.grow(newTimeslots);
          } else {
            const currentMapping = ps.getTimeslotMapping();
            const sorted = [...currentMapping.entries()].sort((a, b) => {
              const distA = Math.abs(toDate(a[0]).getTime() - time.getTime());
              const distB = Math.abs(toDate(b[0]).getTime() - time.getTime());
              return distA - distB;
            });
            const keptEntries = sorted.slice(0, newTimeslots);
            const keptMapping = new Map(keptEntries.map(([ts], i) => [ts, i]));

            ps.shrink(newTimeslots, keptMapping);
            this.timestepService.setGpuState(param, new Set(keptMapping.keys()));
            ps.setActiveTimesteps([]);
            this.deactivateParam(param);
          }
        }

        this.timeslotsPerLayer = newTimeslots;
        this.slotsVersion.value++;
      }

      // Ensure ParamSlots exist for all active params
      this.ensureParamSlots(newActiveParams);

      // Update wanted state and activate for each param
      for (const param of newActiveParams) {
        const ps = this.paramSlots.get(param)!;
        const wanted = this.computeWanted(time);
        this.activateIfReady(param, ps, wanted);

        ps.wanted.value = wanted;
      }
    });
  }

  /**
   * Collect all unique params from enabled layers (built-in + custom)
   */
  private collectActiveParams(): Set<string> {
    const params = new Set<string>();

    for (const layer of this.layerService.getAll()) {
      if (this.layerService.isLayerEnabled(layer.id) && layer.params) {
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

    let pastCursor = t0;
    let futureCursor = t1;

    const numSlots = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

    while (window.length < numSlots) {
      const canAddFuture = futureCursor !== this.dataWindowEnd;
      const canAddPast = pastCursor !== this.dataWindowStart;

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

      if (futureCount <= pastCount && canAddFuture) {
        futureCursor = this.timestepService.next(futureCursor);
        window.push(futureCursor);
      } else if (canAddPast) {
        pastCursor = this.timestepService.prev(pastCursor);
        window.push(pastCursor);
      } else if (canAddFuture) {
        futureCursor = this.timestepService.next(futureCursor);
        window.push(futureCursor);
      }
    }

    return window;
  }

  /**
   * Activate shader if required slots are loaded.
   * Sends activateSlots to worker with param name directly (param-centric API).
   */
  private activateIfReady(param: string, ps: ParamSlots, wanted: WantedState): void {
    const current = ps.getActiveTimesteps();
    const pcode = P(param);

    if (wanted.mode === 'single') {
      const ts = wanted.priority[0]!;
      const slot = ps.getSlot(ts);
      DEBUG && console.log(`[ParamSlot] ${pcode} activateIfReady: slot=${JSON.stringify(slot)}`);
      if (slot?.loaded) {
        if (current.length === 1 && current[0] === ts) return;
        ps.setActiveTimesteps([ts]);

        const t = this.timestepService.toDate(ts).getTime();
        // Param-centric API: send param name directly to worker
        this.auroraService.activateSlots(param, slot.slotIndex, slot.slotIndex, t, t, slot.loadedPoints);
        DEBUG && console.log(`[ParamSlot] ${pcode} activated: ${fmt(ts)}`);
      } else {
        if (current.length > 0) {
          ps.setActiveTimesteps([]);
          this.deactivateParam(param);
          DEBUG && console.log(`[ParamSlot] ${pcode} deactivated (single slot not loaded)`);
        }
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
        // Param-centric API: send param name directly to worker
        this.auroraService.activateSlots(param, slot0.slotIndex, slot1.slotIndex, t0, t1, Math.min(slot0.loadedPoints, slot1.loadedPoints));
        DEBUG && console.log(`[ParamSlot] ${pcode} activated: ${fmt(ts0)} → ${fmt(ts1)}`);
      } else {
        if (current.length > 0) {
          ps.setActiveTimesteps([]);
          this.deactivateParam(param);
          DEBUG && console.log(`[ParamSlot] ${pcode} deactivated (pair slots not loaded)`);
        }
      }
    }
  }

  /** Deactivate param by signaling to worker that data is not ready */
  private deactivateParam(param: string): void {
    this.auroraService.deactivateSlots(param);
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

    // Skip real data when in test mode
    if (this.testModeParams.has(param)) {
      DEBUG && console.log(`[ParamSlot] ${P(param)} skip (test mode)`);
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
      this.timestepService.setGpuUnloaded(param, result.evicted);
    }

    // Capture length BEFORE upload (buffer is transferred and detached)
    const dataLength = data.length;

    // Upload to worker with param name directly (param-centric API)
    this.auroraService.uploadData(param, result.slotIndex, data);

    // Mark loaded
    ps.markLoaded(timestep, result.slotIndex, dataLength);

    // Update timestep service (param-centric)
    this.timestepService.setGpuLoaded(param, timestep);
    this.timestepService.setCached(param, timestep, data.byteLength);

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

      // Get layer ID for QueueTask.param (built-in or first user layer using this param)
      const layers = this.layerService.getLayersForParam(param);
      const layer = layers[0]?.id;
      if (!layer) continue;

      for (const ts of wanted.priority) {
        ps.setLoading([ts]);
        allOrders.push({
          url: this.timestepService.url(ts),
          param: layer,  // Legacy: QueueTask expects layer name
          timestep: ts,
          sizeEstimate: this.timestepService.getSize(param, ts),  // Use param directly
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
            // Capture length BEFORE upload (buffer is transferred and detached)
            const dataLength = slice.data.length;
            this.auroraService.uploadData(param, result.slotIndex, slice.data);
            ps.markLoaded(order.timestep, result.slotIndex, dataLength);
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
    return this.paramSlots.get(param)!.getActiveTimesteps();
  }

  /** Check if a param has data activated in the shader */
  isParamReady(param: string): boolean {
    const ps = this.paramSlots.get(param);
    return ps ? ps.getActiveTimesteps().length > 0 : false;
  }

  /** Slot stats per param for diagnostics and e2e tests */
  getSlotStats(): Record<string, { capacity: number; loaded: number }> {
    const stats: Record<string, { capacity: number; loaded: number }> = {};
    for (const [param, ps] of this.paramSlots) {
      stats[param] = { capacity: ps.getCapacity(), loaded: ps.getLoadedCount() };
    }
    return stats;
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

  /**
   * Inject test data directly - bypasses queue/fetch.
   * @param layer Layer name (e.g., 'pressure') - mapped to params via LayerService
   * @param data Float32Array or array of Float32Arrays (for multi-param layers like wind)
   */
  injectTestData(layer: string, data: Float32Array | Float32Array[]): void {
    const layerDecl = this.layerService.get(layer);
    if (!layerDecl?.params?.length) {
      console.warn(`[ParamSlot] injectTestData: no params for layer ${layer}`);
      return;
    }

    const slabs = Array.isArray(data) ? data : [data];
    const points = slabs[0]!.length;

    // Upload each slab to corresponding param
    const fakeTs = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') as TTimestep;
    for (let i = 0; i < layerDecl.params.length && i < slabs.length; i++) {
      const param = layerDecl.params[i]!;
      // Mark as test mode - ignore real data from queue
      this.testModeParams.add(param);
      this.auroraService.uploadData(param, 0, slabs[i]!);
      const t = Date.now();
      this.auroraService.activateSlots(param, 0, 0, t, t, points);

      // Update main-thread state so isParamReady() reflects the injection
      this.ensureParamSlots(new Set([param]));
      this.paramSlots.get(param)!.setActiveTimesteps([fakeTs]);
    }
    this.slotsVersion.value++;
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
