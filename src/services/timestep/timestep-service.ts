/**
 * TimestepService - Unified timestep discovery and state management
 *
 * Discovers available timesteps from Open-Meteo S3 bucket and tracks
 * availability across three levels:
 * - ECMWF: global (same for all params)
 * - Cache: per param (from Service Worker)
 * - GPU: per param (set by SlotService when textures uploaded)
 */

import { signal } from '@preact/signals-core';
import { type TTimestep, type Timestep, type QueueTask, type TimestepOrder } from '../../config/types';
import type { LayerService } from '../layer/layer-service';
import { parseTimestep, formatTimestep } from '../../utils/timestep';
import { countBeforeTimestep, clearBeforeTimestep } from '../sw-registration';
import { MODELS, getParamMeta, type TModel, type TModelParam } from '../../config/models';

// Module imports
import { discoverModel } from './discovery';
import { querySWCache } from './cache';
import * as cache from './cache';
import * as gpu from './gpu';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Timestep state per param */
export interface ParamState {
  cache: Set<TTimestep>;
  gpu: Set<TTimestep>;
  sizes: Map<TTimestep, number>;  // Known compressed sizes (bytes), NaN = unknown
}

/** TimestepService state exposed via signal */
export interface TimestepState {
  ecmwf: Set<TTimestep>;
  params: Map<TModelParam['param'], ParamState>;  // Keyed by param name (e.g., 'temperature_2m')
}

/** 4-letter uppercase param code for logs */
const P = (mp: { param: string; model?: string }) =>
  mp.param.replace(/_/g, '').slice(0, 5).toUpperCase() + (mp.model ? mp.model[0]!.toUpperCase() : '');

// ─────────────────────────────────────────────────────────────────────────────
// TimestepService
// ─────────────────────────────────────────────────────────────────────────────

export class TimestepService {
  // Discovery data — keyed by TModel (internal indexing for discovery Records)
  private timestepsData = {} as Record<TModel, Timestep[]>;
  private timestepIndex = {} as Record<TModel, Map<TTimestep, number>>;
  private variablesData = {} as Record<TModel, string[]>;
  /** Primary model — drives timebar navigation */
  private readonly primaryModel: TModel;

  /** Reverse lookup: param name → TModelParam (built during initialize from layer declarations) */
  private paramModelMap = new Map<string, TModelParam>();

  /** Reactive state for UI */
  readonly state = signal<TimestepState>({
    ecmwf: new Set(),
    params: new Map(),
  });

  constructor(
    private layerService: LayerService,
  ) {
    this.primaryModel = MODELS[0].name as TModel;

    for (const m of MODELS) {
      this.timestepsData[m.name as TModel] = [];
      this.timestepIndex[m.name as TModel] = new Map();
      this.variablesData[m.name as TModel] = [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async initialize(onProgress?: (step: 'manifest' | 'runs' | 'cache' | 'cleanup', detail?: string) => Promise<void>): Promise<void> {

    // Discover timesteps for each model
    for (const modelDef of MODELS) {
      const model = modelDef.name as TModel;
      const result = await discoverModel(model, modelDef.root, onProgress);
      this.timestepsData[model] = result.timesteps;
      this.variablesData[model] = result.variables;

      // Build index for fast lookup
      const index = new Map<TTimestep, number>();
      for (const ts of result.timesteps) {
        index.set(ts.timestep, ts.index);
      }
      this.timestepIndex[model] = index;
    }

    // Build ECMWF set from discovered timesteps
    const ecmwf = new Set<TTimestep>();
    for (const ts of this.timestepsData[this.primaryModel]) {
      ecmwf.add(ts.timestep);
    }

    // Query SW cache per param (each param against its own model's timesteps)
    const params = new Map<TModelParam['param'], ParamState>();

    for (const modelDef of MODELS) {
      const model = modelDef.name as TModel;
      for (const mp of this.layerService.getParamsForModel(model)) {
        if (params.has(mp.param)) continue;
        this.paramModelMap.set(mp.param, mp);
        await onProgress?.('cache', mp.param);
        const { cache, sizes } = await querySWCache(mp.param, this.timestepsData[mp.model]);
        params.set(mp.param, { cache, gpu: new Set(), sizes });

        if (sizes.size > 0) {
          const avgMB = ([...sizes.values()].reduce((a, b) => a + b, 0) / sizes.size / 1024 / 1024).toFixed(1);
          console.log(`[Timestep] ${P(mp)}: ${sizes.size} cached, avg ${avgMB}MB`);
        }
      }
    }

    this.state.value = { ecmwf, params };

    // Log summary per model
    const fmt = (t: TTimestep) => t.slice(5, 13);
    for (const modelDef of MODELS) {
      const model = modelDef.name as TModel;
      const modelTs = this.timestepsData[model];
      const vars = this.variablesData[model];
      if (modelTs.length > 0) {
        console.log(`[Timestep] ${model}: ${vars.length} V, ${modelTs.length} TS, ${fmt(modelTs[0]!.timestep)} - ${fmt(modelTs[modelTs.length - 1]!.timestep)}`);
      }
    }

    // Clean up cache entries older than earliest available timestep (primary model)
    try {
      const primaryTs = this.timestepsData[this.primaryModel];
      const earliest = primaryTs[0]!.timestep;
      const outdatedCount = await countBeforeTimestep(earliest);
      if (outdatedCount > 0) {
        await onProgress?.('cleanup', `Deleting ${outdatedCount} outdated cache entries...`);
        const deleted = await clearBeforeTimestep(earliest);
        console.log(`[Timestep] Deleted ${deleted} outdated cache entries (before ${fmt(earliest)})`);
      }
    } catch (err) {
      console.warn('[Timestep] Cache cleanup failed:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Dynamic Param Registration
  // ─────────────────────────────────────────────────────────────────────────────

  /** Ensure param exists in state (for custom layers added after init) */
  ensureParam(param: TModelParam['param']): void {
    if (this.state.value.params.has(param)) return;

    // Create new ParamState
    const paramState: ParamState = {
      cache: new Set(),
      gpu: new Set(),
      sizes: new Map(),
    };

    // Update state immutably
    const newParams = new Map(this.state.value.params);
    newParams.set(param, paramState);
    this.state.value = { ...this.state.value, params: newParams };

    console.log(`[Timestep] Added param: ${P({ param })}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cache State (delegates to cache.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  setCached(param: TModelParam['param'], timestep: TTimestep, sizeBytes: number): void {
    this.ensureParam(param);  // Auto-create if needed
    cache.setCached(this.state, param, timestep, sizeBytes);
  }

  async refreshCacheState(mp: TModelParam): Promise<void> {
    await cache.refreshCacheState(this.state, mp.param, this.timestepsData[mp.model]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GPU State (delegates to gpu.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  setGpuLoaded(param: TModelParam['param'], timestep: TTimestep): void {
    this.ensureParam(param);  // Auto-create if needed
    gpu.setGpuLoaded(this.state, param, timestep);
  }

  setGpuUnloaded(param: TModelParam['param'], timestep: TTimestep): void {
    gpu.setGpuUnloaded(this.state, param, timestep);
  }

  clearGpuState(param: TModelParam['param']): void {
    gpu.clearGpuState(this.state, param);
  }

  setGpuState(param: TModelParam['param'], timesteps: Set<TTimestep>): void {
    gpu.setGpuState(this.state, param, timesteps);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Size Management
  // ─────────────────────────────────────────────────────────────────────────────

  getSize(param: TModelParam['param'], timestep: TTimestep): number {
    return this.state.value.params.get(param)?.sizes.get(timestep) ?? NaN; // QC-OK: NaN = unknown size
  }

  setSize(param: TModelParam['param'], timestep: TTimestep, bytes: number): void {
    const paramState = this.state.value.params.get(param);
    if (!paramState) return;
    paramState.sizes.set(timestep, bytes);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────────

  toDate(ts: TTimestep): Date {
    return parseTimestep(ts);
  }

  next(ts: TTimestep): TTimestep {
    const idx = this.timestepIndex[this.primaryModel].get(ts)!;
    return this.timestepsData[this.primaryModel][idx + 1]!.timestep;
  }

  prev(ts: TTimestep): TTimestep {
    const idx = this.timestepIndex[this.primaryModel].get(ts)!;
    return this.timestepsData[this.primaryModel][idx - 1]!.timestep;
  }

  adjacent(time: Date): [TTimestep, TTimestep] {
    const data = this.timestepsData[this.primaryModel];
    const targetMs = time.getTime();

    // Binary search for the right bracket
    let lo = 0;
    let hi = data.length - 1;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midMs = parseTimestep(data[mid]!.timestep).getTime();
      if (midMs < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // lo is now the first timestep >= time
    const t1Idx = lo;
    const t0Idx = Math.max(0, t1Idx - 1);

    // Clamp to valid range
    const t0 = data[t0Idx]!.timestep;
    const t1 = data[Math.min(t1Idx, data.length - 1)]!.timestep;

    return [t0, t1];
  }

  url(ts: TTimestep, mp: TModelParam): string {
    const idx = this.timestepIndex[mp.model].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts} for model ${mp.model}`);
    return this.timestepsData[mp.model][idx]!.url;
  }

  /**
   * Resolve the correct URL for a (timestep, param) pair.
   * Backward-sum params (e.g. precipitation) are undefined at analysis (T+0)
   * timesteps — uses fallbackUrl from previous run where this time is T+6.
   */
  resolveUrl(ts: TTimestep, mp: TModelParam): string {
    const idx = this.timestepIndex[mp.model].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts} for model ${mp.model}`);
    const entry = this.timestepsData[mp.model][idx]!;
    const meta = getParamMeta(mp.param);
    if (meta.backwardSum && entry.isAnalysis && entry.fallbackUrl) {
      console.log(`[Timestep] ${P(mp)} at ${ts}: using previous run (analysis, backward sum)`);
      return entry.fallbackUrl;
    }
    return entry.url;
  }

  /**
   * First visible timestep — trimmed 6h past the raw data start.
   *
   * Precipitation (and other backward-sum params) is undefined at analysis
   * timesteps (T+0 of each model run). The oldest data comes from gap-fill
   * runs whose T+0 is the very first entry. Trimming 6h ensures the timebar
   * never starts on an analysis timestep with missing backward-sum data.
   */
  first(): TTimestep {
    const data = this.timestepsData[this.primaryModel];
    const firstMs = parseTimestep(data[0]!.timestep).getTime();
    const cutoffMs = firstMs + 6 * 60 * 60 * 1000;
    for (const entry of data) {
      if (parseTimestep(entry.timestep).getTime() >= cutoffMs) return entry.timestep;
    }
    return data[0]!.timestep;
  }

  last(): TTimestep {
    const data = this.timestepsData[this.primaryModel];
    return data[data.length - 1]!.timestep;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Per-model Navigation (data pipeline)
  // ─────────────────────────────────────────────────────────────────────────────

  adjacentFor(time: Date, mp: TModelParam): [TTimestep, TTimestep] {
    const data = this.timestepsData[mp.model];
    const targetMs = time.getTime();

    let lo = 0;
    let hi = data.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (parseTimestep(data[mid]!.timestep).getTime() < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const t1Idx = lo;
    const t0Idx = Math.max(0, t1Idx - 1);
    return [
      data[t0Idx]!.timestep,
      data[Math.min(t1Idx, data.length - 1)]!.timestep,
    ];
  }

  firstFor(mp: TModelParam): TTimestep {
    return this.timestepsData[mp.model][0]!.timestep;
  }

  lastFor(mp: TModelParam): TTimestep {
    const data = this.timestepsData[mp.model];
    return data[data.length - 1]!.timestep;
  }

  nextFor(ts: TTimestep, mp: TModelParam): TTimestep {
    const idx = this.timestepIndex[mp.model].get(ts)!;
    return this.timestepsData[mp.model][idx + 1]!.timestep;
  }

  prevFor(ts: TTimestep, mp: TModelParam): TTimestep {
    const idx = this.timestepIndex[mp.model].get(ts)!;
    return this.timestepsData[mp.model][idx - 1]!.timestep;
  }

  /** Get TModelParam for a param name (bridge from string-keyed internal state) */
  getModelParam(param: string): TModelParam {
    const mp = this.paramModelMap.get(param);
    if (!mp) throw new Error(`No model mapping for param: ${param}`);
    return mp;
  }

  getExactTimestep(time: Date): TTimestep | null {
    const ts = formatTimestep(time);
    return this.timestepIndex[this.primaryModel].has(ts) ? ts : null;
  }

  getClosestTimestep(time: Date): Date {
    const [t0, t1] = this.adjacent(time);
    const t0Date = parseTimestep(t0);
    const t1Date = parseTimestep(t1);
    const d0 = Math.abs(time.getTime() - t0Date.getTime());
    const d1 = Math.abs(time.getTime() - t1Date.getTime());
    return d0 <= d1 ? t0Date : t1Date;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Window Calculation
  // ─────────────────────────────────────────────────────────────────────────────

  getWindow(time: Date, numSlots: number): TTimestep[] {
    const [t0, t1] = this.adjacent(time);
    const window: TTimestep[] = [t0, t1];
    const first = this.first();
    const last = this.last();

    let pastCursor = t0;
    let futureCursor = t1;

    while (window.length < numSlots) {
      const canAddFuture = futureCursor !== last;
      const canAddPast = pastCursor !== first;

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

      if (futureCount <= pastCount && canAddFuture) {
        futureCursor = this.next(futureCursor);
        window.push(futureCursor);
      } else if (canAddPast) {
        pastCursor = this.prev(pastCursor);
        window.push(pastCursor);
      } else if (canAddFuture) {
        futureCursor = this.next(futureCursor);
        window.push(futureCursor);
      }
    }

    return window;
  }

  /** Compute load window for a specific model's timestep grid */
  getWindowFor(time: Date, numSlots: number, mp: TModelParam): TTimestep[] {
    const [t0, t1] = this.adjacentFor(time, mp);
    const window: TTimestep[] = [t0, t1];
    const first = this.firstFor(mp);
    const last = this.lastFor(mp);

    let pastCursor = t0;
    let futureCursor = t1;

    while (window.length < numSlots) {
      const canAddFuture = futureCursor !== last;
      const canAddPast = pastCursor !== first;

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

      if (futureCount <= pastCount && canAddFuture) {
        futureCursor = this.nextFor(futureCursor, mp);
        window.push(futureCursor);
      } else if (canAddPast) {
        pastCursor = this.prevFor(pastCursor, mp);
        window.push(pastCursor);
      } else if (canAddFuture) {
        futureCursor = this.nextFor(futureCursor, mp);
        window.push(futureCursor);
      }
    }

    return window;
  }

  /**
   * Minimum tasks for a given time — 1 timestep (exact match) or 2 (interpolation pair).
   * Resolves backward-sum fallback URLs. Used by bootstrap for first render.
   */
  getUrlTimeTasks(time: Date, activeLayers: string[]): TimestepOrder[] {
    const orders: TimestepOrder[] = [];

    for (const layerId of activeLayers) {
      const layerDecl = this.layerService.get(layerId)!;
      if (!layerDecl.params) continue;

      for (let slabIndex = 0; slabIndex < layerDecl.params.length; slabIndex++) {
        const mp = layerDecl.params[slabIndex]!;
        const [t0, t1] = this.adjacentFor(time, mp);

        // Exact match → single timestep, otherwise interpolation pair
        const exactTs = this.getExactTimestep(time);
        const timesteps = (exactTs && this.adjacentFor(time, mp)[0] === exactTs)
          ? [exactTs]
          : [t0, t1];

        for (const ts of timesteps) {
          const meta = getParamMeta(mp.param);
          const paramState = this.state.value.params.get(mp.param);
          orders.push({
            url: this.resolveUrl(ts, mp),
            param: layerId,
            timestep: ts,
            sizeEstimate: paramState?.sizes.get(ts) ?? meta.sizeEstimate,
            slabIndex,
            modelParam: mp,
          });
        }
      }
    }

    return orders;
  }

  getWindowTasks(time: Date, numSlots: number, activeLayers: string[]): {
    window: TTimestep[];
    tasks: QueueTask[];
  } {
    // Collect unique models from active layers (use first TModelParam per model for navigation)
    const modelRepresentative = new Map<string, TModelParam>();
    for (const layer of activeLayers) {
      const layerDecl = this.layerService.get(layer)!;
      if (!layerDecl.params) continue;
      for (const mp of layerDecl.params) {
        if (!modelRepresentative.has(mp.model)) modelRepresentative.set(mp.model, mp);
      }
    }

    // Compute per-model windows
    const modelWindows = new Map<string, TTimestep[]>();
    const windowUnion: TTimestep[] = [];
    for (const [model, mp] of modelRepresentative) {
      const w = this.getWindowFor(time, numSlots, mp);
      modelWindows.set(model, w);
      for (const ts of w) {
        if (!windowUnion.includes(ts)) windowUnion.push(ts);
      }
    }

    // Build tasks — each param uses its own model's window
    const tasks: QueueTask[] = [];
    for (const layer of activeLayers) {
      const layerDecl = this.layerService.get(layer)!;
      if (!layerDecl.params) continue;

      for (let slabIndex = 0; slabIndex < layerDecl.params.length; slabIndex++) {
        const mp = layerDecl.params[slabIndex]!;
        const w = modelWindows.get(mp.model)!;

        const meta = getParamMeta(mp.param);

        for (const timestep of w) {
          const paramState = this.state.value.params.get(mp.param)!;
          if (paramState.gpu.has(timestep)) continue;

          const url = this.resolveUrl(timestep, mp);
          const isFast = paramState.cache.has(timestep);
          const sizeEstimate = paramState.sizes.get(timestep) ?? meta.sizeEstimate;

          tasks.push({
            url,
            param: layer,
            timestep,
            sizeEstimate,
            modelParam: mp,
            slabIndex,
            isFast,
          });
        }
      }
    }

    return { window: windowUnion, tasks };
  }
}
