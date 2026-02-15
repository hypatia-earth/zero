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
import { type TTimestep, type TModel, type Timestep, type QueueTask } from '../../config/types';
import type { ConfigService } from '../config-service';
import type { LayerService } from '../layer/layer-service';
import { parseTimestep, formatTimestep } from '../../utils/timestep';
import { countBeforeTimestep, clearBeforeTimestep } from '../sw-registration';
import { PARAM_METADATA } from '../../config/param-metadata';

// Module imports
import { discoverModel } from './discovery';
import { querySWCache, setCached as setCachedFn, refreshCacheState as refreshCacheStateFn } from './cache';
import { setGpuLoaded as setGpuLoadedFn, setGpuUnloaded as setGpuUnloadedFn, clearGpuState as clearGpuStateFn, setGpuState as setGpuStateFn } from './gpu';

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
  params: Map<string, ParamState>;  // Keyed by param name (e.g., 'temperature_2m')
}

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.slice(0, 4).toUpperCase();

// ─────────────────────────────────────────────────────────────────────────────
// TimestepService
// ─────────────────────────────────────────────────────────────────────────────

export class TimestepService {
  // Discovery data (cast: populated by constructor loop)
  private timestepsData = {} as Record<TModel, Timestep[]>;
  private timestepIndex = {} as Record<TModel, Map<TTimestep, number>>;
  private variablesData = {} as Record<TModel, string[]>;
  private readonly bucketRoot: string;
  private defaultModel: TModel;

  /** Reactive state for UI */
  readonly state = signal<TimestepState>({
    ecmwf: new Set(),
    params: new Map(),
  });

  constructor(
    private configService: ConfigService,
    private layerService: LayerService,
  ) {
    const config = this.configService.getDiscovery();
    this.bucketRoot = config.root.replace(/\/data_spatial\/?$/, '');
    this.defaultModel = config.default;

    for (const model of config.models) {
      this.timestepsData[model] = [];
      this.timestepIndex[model] = new Map();
      this.variablesData[model] = [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async initialize(onProgress?: (step: 'manifest' | 'runs' | 'cache' | 'cleanup', detail?: string) => Promise<void>): Promise<void> {
    const config = this.configService.getDiscovery();

    // Discover timesteps for each model
    for (const model of config.models) {
      const result = await discoverModel(model, config, this.bucketRoot, onProgress);
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
    for (const ts of this.timestepsData[config.default]) {
      ecmwf.add(ts.timestep);
    }

    // Query SW cache per param
    const params = new Map<string, ParamState>();

    for (const param of this.layerService.getAllParams()) {
      await onProgress?.('cache', param);
      const { cache, sizes } = await querySWCache(param, this.timestepsData[this.defaultModel]);
      params.set(param, { cache, gpu: new Set(), sizes });

      const avgMB = sizes.size > 0
        ? ([...sizes.values()].reduce((a, b) => a + b, 0) / sizes.size / 1024 / 1024).toFixed(1)
        : '0';
      console.log(`[Timestep] ${P(param)}: ${sizes.size} cached, avg ${avgMB}MB`);
    }

    this.state.value = { ecmwf, params };

    // Log summary
    const ts = this.timestepsData[config.default];
    const vars = this.variablesData[config.default];
    const fmt = (t: TTimestep) => t.slice(5, 13);
    console.log(`[Timestep] ${vars.length} V, ${ts.length} TS, ${fmt(ts[0]!.timestep)} - ${fmt(ts[ts.length - 1]!.timestep)}`);

    // Clean up cache entries older than earliest available timestep
    try {
      const earliest = ts[0]!.timestep;
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
  ensureParam(param: string): void {
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

    console.log(`[Timestep] Added param: ${P(param)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cache State (delegates to cache.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  setCached(param: string, timestep: TTimestep, sizeBytes: number): void {
    this.ensureParam(param);  // Auto-create if needed
    setCachedFn(this.state, param, timestep, sizeBytes);
  }

  async refreshCacheState(param: string): Promise<void> {
    await refreshCacheStateFn(this.state, param, this.timestepsData[this.defaultModel]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GPU State (delegates to gpu.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  setGpuLoaded(param: string, timestep: TTimestep): void {
    this.ensureParam(param);  // Auto-create if needed
    setGpuLoadedFn(this.state, param, timestep);
  }

  setGpuUnloaded(param: string, timestep: TTimestep): void {
    setGpuUnloadedFn(this.state, param, timestep);
  }

  clearGpuState(param: string): void {
    clearGpuStateFn(this.state, param);
  }

  setGpuState(param: string, timesteps: Set<TTimestep>): void {
    setGpuStateFn(this.state, param, timesteps);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Size Management
  // ─────────────────────────────────────────────────────────────────────────────

  getSize(param: string, timestep: TTimestep): number {
    return this.state.value.params.get(param)?.sizes.get(timestep) ?? NaN;
  }

  setSize(param: string, timestep: TTimestep, bytes: number): void {
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

  next(ts: TTimestep, model?: TModel): TTimestep | null {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) return null;
    const nextEntry = this.timestepsData[m][idx + 1];
    return nextEntry?.timestep ?? null;
  }

  prev(ts: TTimestep, model?: TModel): TTimestep | null {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined || idx === 0) return null;
    const prevEntry = this.timestepsData[m][idx - 1];
    return prevEntry?.timestep ?? null;
  }

  adjacent(time: Date, model?: TModel): [TTimestep, TTimestep] {
    const m = model ?? this.defaultModel;
    const data = this.timestepsData[m];
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

  url(ts: TTimestep, model?: TModel): string {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts}`);
    return this.timestepsData[m][idx]!.url;
  }

  first(model?: TModel): TTimestep {
    const m = model ?? this.defaultModel;
    return this.timestepsData[m][0]!.timestep;
  }

  last(model?: TModel): TTimestep {
    const m = model ?? this.defaultModel;
    const data = this.timestepsData[m];
    return data[data.length - 1]!.timestep;
  }

  getExactTimestep(time: Date, model?: TModel): TTimestep | null {
    const m = model ?? this.defaultModel;
    const ts = formatTimestep(time);
    return this.timestepIndex[m].has(ts) ? ts : null;
  }

  getClosestTimestep(time: Date, model?: TModel): Date {
    const [t0, t1] = this.adjacent(time, model);
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

    let pastCursor = this.prev(t0);
    let futureCursor = this.next(t1);

    while (window.length < numSlots) {
      const canAddFuture = futureCursor !== null;
      const canAddPast = pastCursor !== null;

      if (!canAddFuture && !canAddPast) break;

      const futureCount = window.filter(ts => ts > t0).length;
      const pastCount = window.filter(ts => ts < t0).length;

      if (futureCount <= pastCount && canAddFuture) {
        window.push(futureCursor!);
        futureCursor = this.next(futureCursor!);
      } else if (canAddPast) {
        window.push(pastCursor!);
        pastCursor = this.prev(pastCursor!);
      } else if (canAddFuture) {
        window.push(futureCursor!);
        futureCursor = this.next(futureCursor!);
      }
    }

    return window;
  }

  getWindowTasks(time: Date, numSlots: number, activeLayers: string[]): {
    window: TTimestep[];
    tasks: QueueTask[];
  } {
    const window = this.getWindow(time, numSlots);
    const tasks: QueueTask[] = [];

    for (const layer of activeLayers) {
      const layerDecl = this.layerService.get(layer);
      const omParams = layerDecl?.params ?? [layer];

      for (const timestep of window) {
        for (let slabIndex = 0; slabIndex < omParams.length; slabIndex++) {
          const omParam = omParams[slabIndex]!;

          const paramState = this.state.value.params.get(omParam);
          if (paramState?.gpu.has(timestep)) continue;

          const isFast = paramState?.cache.has(timestep) ?? false;
          const defaultSize = PARAM_METADATA[omParam]?.sizeEstimate ?? 0;
          const sizeEstimate = paramState?.sizes.get(timestep) ?? defaultSize;
          const url = this.url(timestep);

          tasks.push({
            url,
            param: layer,
            timestep,
            sizeEstimate,
            omParam,
            slabIndex,
            isFast,
          });
        }
      }
    }

    return { window, tasks };
  }
}
