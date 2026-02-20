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
import { PARAM_METADATA } from '../../config/params-ecmwf_ifs';

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
  params: Map<string, ParamState>;  // Keyed by param name (e.g., 'temperature_2m')
}

/** 4-letter uppercase param code for logs */
const P = (param: string) => param.replace(/_/g, '').slice(0, 5).toUpperCase();

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

      if (sizes.size > 0) {
        const avgMB = ([...sizes.values()].reduce((a, b) => a + b, 0) / sizes.size / 1024 / 1024).toFixed(1);
        console.log(`[Timestep] ${P(param)}: ${sizes.size} cached, avg ${avgMB}MB`);
      }
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
    cache.setCached(this.state, param, timestep, sizeBytes);
  }

  async refreshCacheState(param: string): Promise<void> {
    await cache.refreshCacheState(this.state, param, this.timestepsData[this.defaultModel]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GPU State (delegates to gpu.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  setGpuLoaded(param: string, timestep: TTimestep): void {
    this.ensureParam(param);  // Auto-create if needed
    gpu.setGpuLoaded(this.state, param, timestep);
  }

  setGpuUnloaded(param: string, timestep: TTimestep): void {
    gpu.setGpuUnloaded(this.state, param, timestep);
  }

  clearGpuState(param: string): void {
    gpu.clearGpuState(this.state, param);
  }

  setGpuState(param: string, timesteps: Set<TTimestep>): void {
    gpu.setGpuState(this.state, param, timesteps);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Size Management
  // ─────────────────────────────────────────────────────────────────────────────

  getSize(param: string, timestep: TTimestep): number {
    return this.state.value.params.get(param)?.sizes.get(timestep) ?? NaN; // QC-OK: NaN = unknown size
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

  next(ts: TTimestep): TTimestep {
    const idx = this.timestepIndex[this.defaultModel].get(ts)!;
    return this.timestepsData[this.defaultModel][idx + 1]!.timestep;
  }

  prev(ts: TTimestep): TTimestep {
    const idx = this.timestepIndex[this.defaultModel].get(ts)!;
    return this.timestepsData[this.defaultModel][idx - 1]!.timestep;
  }

  adjacent(time: Date): [TTimestep, TTimestep] {
    const data = this.timestepsData[this.defaultModel];
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

  url(ts: TTimestep): string {
    const idx = this.timestepIndex[this.defaultModel].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts}`);
    return this.timestepsData[this.defaultModel][idx]!.url;
  }

  first(): TTimestep {
    return this.timestepsData[this.defaultModel][0]!.timestep;
  }

  last(): TTimestep {
    const data = this.timestepsData[this.defaultModel];
    return data[data.length - 1]!.timestep;
  }

  getExactTimestep(time: Date): TTimestep | null {
    const ts = formatTimestep(time);
    return this.timestepIndex[this.defaultModel].has(ts) ? ts : null;
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

  getWindowTasks(time: Date, numSlots: number, activeLayers: string[]): {
    window: TTimestep[];
    tasks: QueueTask[];
  } {
    const window = this.getWindow(time, numSlots);
    const tasks: QueueTask[] = [];

    for (const layer of activeLayers) {
      const layerDecl = this.layerService.get(layer)!;
      const paramRefs = layerDecl.params!;

      for (const timestep of window) {
        for (let slabIndex = 0; slabIndex < paramRefs.length; slabIndex++) {
          const ref = paramRefs[slabIndex]!;
          const omParam = ref.param;

          const paramState = this.state.value.params.get(omParam)!;
          if (paramState.gpu.has(timestep)) continue;

          const isFast = paramState.cache.has(timestep);
          const sizeEstimate = paramState.sizes.get(timestep) ?? PARAM_METADATA[omParam]!.sizeEstimate; // QC-OK: size learned at download
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
