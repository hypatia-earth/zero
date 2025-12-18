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
import { isWeatherLayer, type TWeatherLayer, type TTimestep, type TModel, type Timestep, type IDiscoveryService } from '../config/types';
import type { ConfigService } from './config-service';
import { parseTimestep, formatTimestep } from '../utils/timestep';
import { sendSWMessage } from '../utils/sw-message';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ModelRun {
  prefix: string;
  datetime: Date;
  run: string;
}

/** Timestep state per param */
export interface ParamState {
  cache: Set<TTimestep>;
  gpu: Set<TTimestep>;
  sizes: Map<TTimestep, number>;  // Known compressed sizes (bytes), NaN = unknown
}

/** TimestepService state exposed via signal */
export interface TimestepState {
  ecmwf: Set<TTimestep>;
  params: Map<TWeatherLayer, ParamState>;
}

/** SW cache layer detail response */
interface LayerDetail {
  items: Array<{ url: string; sizeMB: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** 4-letter uppercase param code for logs */
const P = (param: TWeatherLayer) => param.slice(0, 4).toUpperCase();

// ─────────────────────────────────────────────────────────────────────────────
// TimestepService
// ─────────────────────────────────────────────────────────────────────────────

export class TimestepService implements IDiscoveryService {
  // Discovery data (cast: populated by constructor loop)
  private timestepsData = {} as Record<TModel, Timestep[]>;
  private timestepIndex = {} as Record<TModel, Map<TTimestep, number>>;
  private variablesData = {} as Record<TModel, string[]>;
  private readonly bucketRoot: string;
  private defaultModel: TModel;

  /** Reactive state for UI */
  readonly state = signal<TimestepState>({
    ecmwf: new Set(),
    params: new Map(),  // Populated by explore()
  });

  constructor(private configService: ConfigService) {
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

  /** Initialize: explore ECMWF and query SW cache */
  async initialize(): Promise<void> {
    const config = this.configService.getDiscovery();

    // Discover timesteps for each model
    for (const model of config.models) {
      await this.exploreModel(model);

      // Build index for fast lookup
      const index = new Map<TTimestep, number>();
      for (const ts of this.timestepsData[model]) {
        index.set(ts.timestep, ts.index);
      }
      this.timestepIndex[model] = index;
    }

    // Build ECMWF set from discovered timesteps
    const ecmwf = new Set<TTimestep>();
    for (const ts of this.timestepsData[config.default]) {
      ecmwf.add(ts.timestep);
    }

    // Query SW cache for ready weather layers only
    const params = new Map<TWeatherLayer, ParamState>();
    const readyWeatherLayers = this.configService.getReadyLayers().filter(isWeatherLayer);
    for (const param of readyWeatherLayers) {
      const { cache, sizes } = await this.querySWCache(param);
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
    const fmt = (t: TTimestep) => t.slice(5, 13); // "MM-DDTHH"
    console.log(`[Timestep] ${config.default}: ${vars.length} V, ${ts.length} TS, ${fmt(ts[0]!.timestep)} - ${fmt(ts[ts.length - 1]!.timestep)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S3 Discovery
  // ─────────────────────────────────────────────────────────────────────────────

  private async exploreModel(model: TModel): Promise<void> {
    const config = this.configService.getDiscovery();
    const basePrefix = `data_spatial/${model}/`;

    // 1. Fetch latest.json → completed run info
    const response = await fetch(`${config.root}${model}/latest.json`);
    if (!response.ok) {
      throw new Error(`[Timestep] Failed to fetch latest.json for ${model}`);
    }
    const data = await response.json();
    this.variablesData[model] = data.variables;
    const completedRunTime = new Date(data.reference_time);
    const completedValidTimes: string[] = data.valid_times ?? [];

    // 2. Find first and newest runs via S3
    const { firstRun, newestRun, newestRunPrefix } = await this.discoverRunBounds(basePrefix);
    if (!firstRun) {
      throw new Error(`[Timestep] No runs found for ${model}`);
    }

    // 3. Check if there's an incomplete run newer than completed
    let incompleteRunTimesteps: string[] | null = null;
    let incompleteRunPrefix: string | null = null;

    if (newestRun && newestRun > completedRunTime) {
      // Incomplete run exists - list its files to see what's available
      const files = await this.listS3Files(newestRunPrefix!);
      incompleteRunTimesteps = files
        .filter(f => f.endsWith('.om'))
        .map(f => {
          const match = /(\d{4}-\d{2}-\d{2}T\d{4})\.om$/.exec(f);
          return match ? match[1]! : null;
        })
        .filter((ts): ts is string => ts !== null);
      incompleteRunPrefix = newestRunPrefix;
    }

    // 4. Generate runs from first to completed (or newest if no incomplete)
    const lastCompleteRun = incompleteRunTimesteps ? completedRunTime : (newestRun ?? completedRunTime);
    const runs = this.generateRuns(basePrefix, firstRun, lastCompleteRun);

    // 5. Generate timesteps
    const timesteps = this.generateTimesteps(
      runs,
      completedRunTime,
      completedValidTimes,
      incompleteRunPrefix,
      incompleteRunTimesteps
    );
    this.timestepsData[model] = timesteps;
  }

  private async discoverRunBounds(basePrefix: string): Promise<{
    firstRun: Date | null;
    newestRun: Date | null;
    newestRunPrefix: string | null;
  }> {
    const pad = (n: number) => n.toString().padStart(2, '0');

    // List months (1-2 requests)
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthsToCheck = new Set<string>();
    monthsToCheck.add(`${weekAgo.getUTCFullYear()}/${pad(weekAgo.getUTCMonth() + 1)}`);
    monthsToCheck.add(`${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}`);

    const dayPrefixes: string[] = [];
    for (const yearMonth of monthsToCheck) {
      const days = await this.listS3Prefixes(`${basePrefix}${yearMonth}/`);
      dayPrefixes.push(...days);
    }
    dayPrefixes.sort();

    if (dayPrefixes.length === 0) {
      return { firstRun: null, newestRun: null, newestRunPrefix: null };
    }

    // List oldest day runs
    const oldestDayRuns = await this.listS3Prefixes(dayPrefixes[0]!);
    const firstRunMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}Z)\/$/.exec(oldestDayRuns[0] ?? '');

    // List newest day runs
    const newestDayRuns = await this.listS3Prefixes(dayPrefixes[dayPrefixes.length - 1]!);
    const newestRunMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}Z)\/$/.exec(newestDayRuns[newestDayRuns.length - 1] ?? '');

    const parseRun = (match: RegExpExecArray | null) =>
      match ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]!.slice(0, 2)}:00:00Z`) : null;

    return {
      firstRun: parseRun(firstRunMatch),
      newestRun: parseRun(newestRunMatch),
      newestRunPrefix: newestRunMatch ? newestDayRuns[newestDayRuns.length - 1]! : null,
    };
  }

  private generateRuns(basePrefix: string, firstRun: Date, lastRun: Date): ModelRun[] {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const runs: ModelRun[] = [];
    const cursor = new Date(firstRun);

    while (cursor <= lastRun) {
      const year = cursor.getUTCFullYear();
      const month = pad(cursor.getUTCMonth() + 1);
      const day = pad(cursor.getUTCDate());
      const hour = pad(cursor.getUTCHours());
      const runTime = `${hour}00Z`;

      runs.push({
        prefix: `${basePrefix}${year}/${month}/${day}/${runTime}/`,
        datetime: new Date(cursor),
        run: runTime,
      });

      cursor.setUTCHours(cursor.getUTCHours() + 6);
    }

    return runs;
  }

  private async listS3Prefixes(prefix: string): Promise<string[]> {
    const url = `${this.bucketRoot}?list-type=2&prefix=${prefix}&delimiter=/`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} listing ${url}`);
    }

    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const prefixes: string[] = [];

    doc.querySelectorAll('CommonPrefixes Prefix').forEach(el => {
      if (el.textContent) prefixes.push(el.textContent);
    });

    return prefixes.sort();
  }

  private async listS3Files(prefix: string): Promise<string[]> {
    const url = `${this.bucketRoot}?list-type=2&prefix=${prefix}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} listing ${url}`);
    }

    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const files: string[] = [];

    doc.querySelectorAll('Contents Key').forEach(el => {
      if (el.textContent) files.push(el.textContent);
    });

    return files.sort();
  }

  private generateTimesteps(
    runs: ModelRun[],
    completedRunTime: Date,
    completedValidTimes: string[],
    incompleteRunPrefix: string | null,
    incompleteRunTimesteps: string[] | null
  ): Timestep[] {
    const timesteps: Timestep[] = [];
    const seen = new Set<TTimestep>();
    const GAP_FILL_HOURS = [0, 1, 2, 3, 4, 5]; // First 6 hours from older runs

    // 1. Add incomplete run timesteps first (highest priority)
    if (incompleteRunPrefix && incompleteRunTimesteps) {
      const runMatch = /\/(\d{4}Z)\/$/.exec(incompleteRunPrefix);
      const runTime = runMatch?.[1] ?? 'unknown';

      for (const tsStr of incompleteRunTimesteps) {
        const ts = tsStr as TTimestep;
        if (!seen.has(ts)) {
          timesteps.push({
            index: 0,
            timestep: ts,
            run: runTime,
            url: `${this.bucketRoot}/${incompleteRunPrefix}${ts}.om`,
          });
          seen.add(ts);
        }
      }
    }

    // 2. Process runs from latest to oldest
    const reversedRuns = [...runs].reverse();

    for (const run of reversedRuns) {
      const isCompletedRun = run.datetime.getTime() === completedRunTime.getTime();

      if (isCompletedRun) {
        // Completed run: use valid_times from latest.json
        for (const isoTime of completedValidTimes) {
          const ts = formatTimestep(new Date(isoTime));
          if (!seen.has(ts)) {
            timesteps.push({
              index: 0,
              timestep: ts,
              run: run.run,
              url: `${this.bucketRoot}/${run.prefix}${ts}.om`,
            });
            seen.add(ts);
          }
        }
      } else {
        // Older runs: compute gap-fill timesteps (first 6 hours)
        for (const hours of GAP_FILL_HOURS) {
          const tsDate = new Date(run.datetime.getTime() + hours * 60 * 60 * 1000);
          const ts = formatTimestep(tsDate);
          if (!seen.has(ts)) {
            timesteps.push({
              index: 0,
              timestep: ts,
              run: run.run,
              url: `${this.bucketRoot}/${run.prefix}${ts}.om`,
            });
            seen.add(ts);
          }
        }
      }
    }

    timesteps.sort((a, b) => a.timestep.localeCompare(b.timestep));
    for (let i = 0; i < timesteps.length; i++) {
      const entry = timesteps[i];
      if (entry) entry.index = i;
    }

    return timesteps;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SW Cache Query
  // ─────────────────────────────────────────────────────────────────────────────

  private async querySWCache(param: TWeatherLayer): Promise<{ cache: Set<TTimestep>; sizes: Map<TTimestep, number> }> {
    const cache = new Set<TTimestep>();
    const sizes = new Map<TTimestep, number>();

    try {
      const detail = await sendSWMessage<LayerDetail>({
        type: 'GET_LAYER_STATS',
        layer: param,
      });

      for (const item of detail.items) {
        const match = /(\d{4}-\d{2}-\d{2}T\d{4})\.om/.exec(item.url);
        if (match) {
          const ts = match[1] as TTimestep;
          cache.add(ts);
          // Parse sizeMB to bytes
          const sizeBytes = parseFloat(item.sizeMB) * 1024 * 1024;
          if (!isNaN(sizeBytes)) {
            sizes.set(ts, (sizes.get(ts) ?? 0) + sizeBytes);
          }
        }
      }
    } catch {
      // SW not available or error - return empty
    }

    return { cache, sizes };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GPU State Management
  // ─────────────────────────────────────────────────────────────────────────────

  setGpuLoaded(param: TWeatherLayer, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.add(timestep);
    this.state.value = { ...current };
  }

  /** Refresh cache state for a param from SW */
  async refreshCacheState(param: TWeatherLayer): Promise<void> {
    const { cache, sizes } = await this.querySWCache(param);
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.cache = cache;
    // Merge new sizes (don't overwrite existing)
    for (const [ts, size] of sizes) {
      if (!paramState.sizes.has(ts)) {
        paramState.sizes.set(ts, size);
      }
    }
    this.state.value = { ...current };
  }

  setGpuUnloaded(param: TWeatherLayer, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.delete(timestep);
    this.state.value = { ...current };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Size Management
  // ─────────────────────────────────────────────────────────────────────────────

  /** Get known size for a timestep (NaN if unknown) */
  getSize(param: TWeatherLayer, timestep: TTimestep): number {
    return this.state.value.params.get(param)?.sizes.get(timestep) ?? NaN;
  }

  /** Set size for a timestep (learned from fetch) */
  setSize(param: TWeatherLayer, timestep: TTimestep, bytes: number): void {
    const paramState = this.state.value.params.get(param);
    if (!paramState) return;
    paramState.sizes.set(timestep, bytes);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State Queries
  // ─────────────────────────────────────────────────────────────────────────────

  isAvailable(timestep: TTimestep): boolean {
    return this.state.value.ecmwf.has(timestep);
  }

  isCached(param: TWeatherLayer, timestep: TTimestep): boolean {
    return this.state.value.params.get(param)?.cache.has(timestep) ?? false;
  }

  isGpuLoaded(param: TWeatherLayer, timestep: TTimestep): boolean {
    return this.state.value.params.get(param)?.gpu.has(timestep) ?? false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // IDiscoveryService Implementation
  // ─────────────────────────────────────────────────────────────────────────────

  explore(): Promise<void> {
    return this.initialize();
  }

  toDate(ts: TTimestep): Date {
    return parseTimestep(ts);
  }

  toTimestep(date: Date): TTimestep {
    return formatTimestep(date);
  }

  toKey(ts: TTimestep): string {
    return parseTimestep(ts).toISOString();
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

  index(ts: TTimestep, model?: TModel): number {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts}`);
    return idx;
  }

  contains(ts: TTimestep, model?: TModel): boolean {
    const m = model ?? this.defaultModel;
    return this.timestepIndex[m].has(ts);
  }

  /** Get timestep if time exactly matches one, null otherwise */
  getExactTimestep(time: Date, model?: TModel): TTimestep | null {
    const ts = this.toTimestep(time);
    return this.contains(ts, model) ? ts : null;
  }

  /** Get closest available timestep to given time */
  getClosestTimestep(time: Date, model?: TModel): Date {
    const [t0, t1] = this.adjacent(time, model);
    const t0Date = this.toDate(t0);
    const t1Date = this.toDate(t1);
    const d0 = Math.abs(time.getTime() - t0Date.getTime());
    const d1 = Math.abs(time.getTime() - t1Date.getTime());
    return d0 <= d1 ? t0Date : t1Date;
  }

  variables(model?: TModel): string[] {
    return this.variablesData[model ?? this.defaultModel];
  }

  timesteps(model?: TModel): Timestep[] {
    return this.timestepsData[model ?? this.defaultModel];
  }
}
