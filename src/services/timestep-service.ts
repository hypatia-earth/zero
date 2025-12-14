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
import type { TParam, TTimestep, TModel, Timestep, IDiscoveryService } from '../config/types';
import type { ConfigService } from './config-service';
import { parseTimestep, formatTimestep, parseFilenameTimestep } from '../utils/timestep';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ModelRun {
  prefix: string;
  datetime: Date;
  run: string;
}

interface ModelConfig {
  gapFillHours: number[];
}

/** Timestep state per param */
export interface ParamState {
  cache: Set<TTimestep>;
  gpu: Set<TTimestep>;
}

/** TimestepService state exposed via signal */
export interface TimestepState {
  ecmwf: Set<TTimestep>;
  params: Map<TParam, ParamState>;
}

/** SW cache layer detail response */
interface LayerDetail {
  items: Array<{ url: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_CONFIGS: Record<TModel, ModelConfig> = {
  ecmwf_ifs: { gapFillHours: [0, 1, 2, 3, 4, 5] },
  ecmwf_ifs025: { gapFillHours: [0, 3] },
};

const PARAMS: TParam[] = ['temp', 'rain', 'wind', 'pressure'];

// ─────────────────────────────────────────────────────────────────────────────
// TimestepService
// ─────────────────────────────────────────────────────────────────────────────

export class TimestepService implements IDiscoveryService {
  // Discovery data
  private timestepsData!: Record<TModel, Timestep[]>;
  private timestepIndex!: Record<TModel, Map<TTimestep, number>>;
  private variablesData!: Record<TModel, string[]>;
  private readonly bucketRoot: string;
  private defaultModel: TModel;

  /** Reactive state for UI */
  readonly state = signal<TimestepState>({
    ecmwf: new Set(),
    params: new Map(PARAMS.map(p => [p, { cache: new Set(), gpu: new Set() }])),
  });

  constructor(private configService: ConfigService) {
    const config = this.configService.getDiscovery();
    this.bucketRoot = config.root.replace(/\/data_spatial\/?$/, '');
    this.defaultModel = config.default;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  /** Initialize: explore ECMWF and query SW cache */
  async initialize(): Promise<void> {
    const config = this.configService.getDiscovery();

    // Initialize records
    this.timestepsData = {} as Record<TModel, Timestep[]>;
    this.timestepIndex = {} as Record<TModel, Map<TTimestep, number>>;
    this.variablesData = {} as Record<TModel, string[]>;

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

    // Query SW cache for each param
    const params = new Map<TParam, ParamState>();
    for (const param of PARAMS) {
      const cache = await this.querySWCache(param);
      params.set(param, { cache, gpu: new Set() });
    }

    this.state.value = { ecmwf, params };

    // Log summary
    const ts = this.timestepsData[config.default];
    const vars = this.variablesData[config.default];
    const fmt = (t: TTimestep) => t.slice(5, 13); // "MM-DDTHH"
    console.log(`[Discovery] ${config.default}: ${vars.length} vars, ${ts.length} steps, ${fmt(ts[0]!.timestep)} - ${fmt(ts[ts.length - 1]!.timestep)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S3 Discovery
  // ─────────────────────────────────────────────────────────────────────────────

  private async exploreModel(model: TModel): Promise<void> {
    const config = this.configService.getDiscovery();

    // Discover runs
    const runs = await this.discoverRuns(`data_spatial/${model}/`);
    if (runs.length === 0) {
      throw new Error(`[Discovery] No runs found for ${model}`);
    }

    // Fetch variables from latest.json
    const response = await fetch(`${config.root}${model}/latest.json`);
    if (!response.ok) {
      throw new Error(`[Discovery] Failed to fetch latest.json for ${model}`);
    }
    const data = await response.json();
    this.variablesData[model] = data.variables;

    // Generate timesteps
    const timesteps = await this.generateTimesteps(runs, model);
    this.timestepsData[model] = timesteps;
  }

  private async discoverRuns(basePrefix: string): Promise<ModelRun[]> {
    const runs: ModelRun[] = [];

    for (const yearPrefix of await this.listS3Prefixes(basePrefix)) {
      const yearMatch = /\/(\d{4})\/$/.exec(yearPrefix);
      if (!yearMatch) continue;
      const year = yearMatch[1] ?? '';

      for (const monthPrefix of await this.listS3Prefixes(yearPrefix)) {
        const monthMatch = /\/(\d{2})\/$/.exec(monthPrefix);
        if (!monthMatch) continue;
        const month = monthMatch[1] ?? '';

        for (const dayPrefix of await this.listS3Prefixes(monthPrefix)) {
          const dayMatch = /\/(\d{2})\/$/.exec(dayPrefix);
          if (!dayMatch) continue;
          const day = dayMatch[1] ?? '';

          for (const runPrefix of await this.listS3Prefixes(dayPrefix)) {
            const runMatch = /\/(\d{4}Z)\/$/.exec(runPrefix);
            if (!runMatch) continue;
            const runTime = runMatch[1] ?? '';

            runs.push({
              prefix: runPrefix,
              datetime: new Date(`${year}-${month}-${day}T${runTime.slice(0, 2)}:00:00Z`),
              run: runTime,
            });
          }
        }
      }
    }

    return runs.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
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

  private async listRunFiles(runPrefix: string): Promise<string[]> {
    const url = `${this.bucketRoot}?list-type=2&prefix=${runPrefix}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} listing ${url}`);
    }

    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const files: string[] = [];

    doc.querySelectorAll('Contents Key').forEach(el => {
      if (el.textContent && el.textContent.endsWith('.om')) {
        files.push(el.textContent);
      }
    });

    return files.sort();
  }

  private async generateTimesteps(runs: ModelRun[], model: TModel): Promise<Timestep[]> {
    const modelConfig = MODEL_CONFIGS[model];
    const timesteps: Timestep[] = [];
    const seen = new Set<TTimestep>();

    // Reverse to process from last to first
    const reversedRuns = [...runs].reverse();
    let isFirst = true;

    for (const run of reversedRuns) {
      if (isFirst) {
        // Last run: fetch all available files
        for (const file of await this.listRunFiles(run.prefix)) {
          const ts = formatTimestep(parseFilenameTimestep(file));
          if (!seen.has(ts)) {
            timesteps.push({ index: 0, timestep: ts, run: run.run, url: `${this.bucketRoot}/${file}` });
            seen.add(ts);
          }
        }
        isFirst = false;
      } else {
        // Previous runs: add first N timesteps
        for (const hours of modelConfig.gapFillHours) {
          const tsDate = new Date(run.datetime.getTime() + hours * 60 * 60 * 1000);
          const ts = formatTimestep(tsDate);
          if (!seen.has(ts)) {
            timesteps.push({ index: 0, timestep: ts, run: run.run, url: `${this.bucketRoot}/${run.prefix}${ts}.om` });
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

  private async querySWCache(param: TParam): Promise<Set<TTimestep>> {
    const cached = new Set<TTimestep>();

    try {
      if (!navigator.serviceWorker.controller) return cached;

      const detail = await this.sendSWMessage<LayerDetail>({
        type: 'GET_LAYER_STATS',
        layer: param,
      });

      for (const item of detail.items) {
        const match = /(\d{4}-\d{2}-\d{2}T\d{4})\.om/.exec(item.url);
        if (match) {
          cached.add(match[1] as TTimestep);
        }
      }
    } catch {
      // SW not available or error - return empty
    }

    return cached;
  }

  private sendSWMessage<T>(message: object): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!navigator.serviceWorker.controller) {
        reject(new Error('No active Service Worker'));
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data as T);
      navigator.serviceWorker.controller.postMessage(message, [channel.port2]);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GPU State Management
  // ─────────────────────────────────────────────────────────────────────────────

  setGpuLoaded(param: TParam, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.add(timestep);
    this.state.value = { ...current };
  }

  setGpuUnloaded(param: TParam, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.delete(timestep);
    this.state.value = { ...current };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State Queries
  // ─────────────────────────────────────────────────────────────────────────────

  isAvailable(timestep: TTimestep): boolean {
    return this.state.value.ecmwf.has(timestep);
  }

  isCached(param: TParam, timestep: TTimestep): boolean {
    return this.state.value.params.get(param)?.cache.has(timestep) ?? false;
  }

  isGpuLoaded(param: TParam, timestep: TTimestep): boolean {
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

  variables(model?: TModel): string[] {
    return this.variablesData[model ?? this.defaultModel];
  }

  timesteps(model?: TModel): Timestep[] {
    return this.timestepsData[model ?? this.defaultModel];
  }
}
