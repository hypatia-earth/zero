/**
 * DiscoveryService - Discovers available timesteps from Open-Meteo S3 bucket
 *
 * Queries the S3 bucket structure to find all available model runs,
 * then stitches them together to build a complete timeline of timesteps.
 *
 * Algorithm:
 * - List all runs via S3 queries (days → runs per day)
 * - Last run: add all available timesteps
 * - Previous runs: add first N timesteps (fills gap between runs)
 *   - ecmwf_ifs (hourly): first 6 timesteps
 *   - ecmwf_ifs025 (3-hourly): first 2 timesteps
 */

import type { ConfigService } from './config-service';
import type { TModel, TTimestep, Timestep, IDiscoveryService } from '../config/types';

interface ModelRun {
  prefix: string;
  datetime: Date;
  run: string;
}

interface ModelConfig {
  gapFillHours: number[];
}

const MODEL_CONFIGS: Record<TModel, ModelConfig> = {
  ecmwf_ifs: { gapFillHours: [0, 1, 2, 3, 4, 5] },
  ecmwf_ifs025: { gapFillHours: [0, 3] },
};

export class DiscoveryService implements IDiscoveryService {
  private timestepsData!: Record<TModel, Timestep[]>;
  private timestepIndex!: Record<TModel, Map<TTimestep, number>>;
  private variablesData!: Record<TModel, string[]>;
  private readonly bucketRoot: string;
  private defaultModel: TModel;

  constructor(private configService: ConfigService) {
    const config = this.configService.getDiscovery();
    this.bucketRoot = config.root.replace(/\/data_spatial\/?$/, '');
    this.defaultModel = config.default;
  }

  async explore(): Promise<void> {
    const config = this.configService.getDiscovery();

    // Initialize records
    this.timestepsData = {} as Record<TModel, Timestep[]>;
    this.timestepIndex = {} as Record<TModel, Map<TTimestep, number>>;
    this.variablesData = {} as Record<TModel, string[]>;

    for (const model of config.models) {
      await this.exploreModel(model);

      // Build index for fast lookup
      const index = new Map<TTimestep, number>();
      for (const ts of this.timestepsData[model]) {
        index.set(ts.timestep, ts.index);
      }
      this.timestepIndex[model] = index;
    }

    // Log summary
    const ts = this.timestepsData[config.default];
    const vars = this.variablesData[config.default];
    const fmt = (t: TTimestep) => t.slice(5, 13); // "MM-DDTHH"
    console.log(`[Discovery] ${config.default}: ${vars.length} vars, ${ts.length} steps, ${fmt(ts[0]!.timestep)} - ${fmt(ts[ts.length - 1]!.timestep)}`);
  }

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

  private parseTimestep(filename: string): Date {
    const match = /(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.om$/.exec(filename);
    if (!match) throw new Error(`Invalid timestep filename: ${filename}`);
    return new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  }

  private formatTimestep(date: Date): TTimestep {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}${min}` as TTimestep;
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
          const ts = this.formatTimestep(this.parseTimestep(file));
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
          const ts = this.formatTimestep(tsDate);
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
  // IDiscoveryService implementation
  // ─────────────────────────────────────────────────────────────────────────────

  /** Convert TTimestep to Date */
  toDate(ts: TTimestep): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})$/.exec(ts);
    if (!match) throw new Error(`Invalid timestep: ${ts}`);
    return new Date(Date.UTC(
      parseInt(match[1]!),
      parseInt(match[2]!) - 1,
      parseInt(match[3]!),
      parseInt(match[4]!),
      parseInt(match[5]!)
    ));
  }

  /** Convert Date to TTimestep */
  toTimestep(date: Date): TTimestep {
    return this.formatTimestep(date);
  }

  /** Convert TTimestep to ISO string for Map/Set keys */
  toKey(ts: TTimestep): string {
    return this.toDate(ts).toISOString();
  }

  /** Get next timestep in discovered list */
  next(ts: TTimestep, model?: TModel): TTimestep | null {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) return null;
    const nextEntry = this.timestepsData[m][idx + 1];
    return nextEntry?.timestep ?? null;
  }

  /** Get previous timestep in discovered list */
  prev(ts: TTimestep, model?: TModel): TTimestep | null {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined || idx === 0) return null;
    const prevEntry = this.timestepsData[m][idx - 1];
    return prevEntry?.timestep ?? null;
  }

  /** Get two timesteps bracketing a given time */
  adjacent(time: Date, model?: TModel): [TTimestep, TTimestep] {
    const m = model ?? this.defaultModel;
    const data = this.timestepsData[m];
    const targetMs = time.getTime();

    // Binary search for the right bracket
    let lo = 0;
    let hi = data.length - 1;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midMs = this.toDate(data[mid]!.timestep).getTime();
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

  /** Get URL for a timestep */
  url(ts: TTimestep, model?: TModel): string {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts}`);
    return this.timestepsData[m][idx]!.url;
  }

  /** Get first timestep */
  first(model?: TModel): TTimestep {
    const m = model ?? this.defaultModel;
    return this.timestepsData[m][0]!.timestep;
  }

  /** Get last timestep */
  last(model?: TModel): TTimestep {
    const m = model ?? this.defaultModel;
    const data = this.timestepsData[m];
    return data[data.length - 1]!.timestep;
  }

  /** Get index of a timestep */
  index(ts: TTimestep, model?: TModel): number {
    const m = model ?? this.defaultModel;
    const idx = this.timestepIndex[m].get(ts);
    if (idx === undefined) throw new Error(`Unknown timestep: ${ts}`);
    return idx;
  }

  /** Check if timestep exists in discovered list */
  contains(ts: TTimestep, model?: TModel): boolean {
    const m = model ?? this.defaultModel;
    return this.timestepIndex[m].has(ts);
  }

  /** Get available variables for a model */
  variables(model?: TModel): string[] {
    return this.variablesData[model ?? this.defaultModel];
  }

  /** Get all timesteps for a model */
  timesteps(model?: TModel): Timestep[] {
    return this.timestepsData[model ?? this.defaultModel];
  }
}
