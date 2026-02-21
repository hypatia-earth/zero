/**
 * S3 Discovery - Explores ECMWF data bucket structure
 *
 * Discovers available model runs and generates timestep metadata
 * by querying S3 bucket listings and latest.json manifests.
 */

import type { Timestep, TTimestep } from '../../config/types';
import type { TModel } from '../../config/models';
import { formatTimestep } from '../../utils/timestep';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ModelRun {
  prefix: string;
  datetime: Date;
  run: string;
}

export interface DiscoveryResult {
  timesteps: Timestep[];
  variables: string[];
}

type ProgressCallback = (step: 'manifest' | 'runs', detail?: string) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Main Discovery Function
// ─────────────────────────────────────────────────────────────────────────────

export async function discoverModel(
  model: TModel,
  modelRoot: string,
  onProgress?: ProgressCallback
): Promise<DiscoveryResult> {
  // modelRoot: e.g. "https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs"
  const rootUrl = new URL(modelRoot);
  const bucketRoot = rootUrl.origin;
  const basePrefix = rootUrl.pathname.replace(/^\//, '').replace(/\/$/, '') + '/';

  // 1. Fetch latest.json → completed run info
  await onProgress?.('manifest', model);
  const response = await fetch(`${modelRoot}/latest.json`);
  if (!response.ok) {
    throw new Error(`[Discovery] Failed to fetch latest.json for ${model}`);
  }
  const data = await response.json();
  if (!data.variables || !data.reference_time || !Array.isArray(data.valid_times)) {
    console.error(`[Discovery] Invalid latest.json for ${model}:`, data);
    throw new Error('Weather data server returned invalid response');
  }
  const variables: string[] = data.variables;
  const completedRunTime = new Date(data.reference_time);
  const completedValidTimes: string[] = data.valid_times;

  // 2. Find first and newest runs via S3
  await onProgress?.('runs', model);
  const { firstRun, newestRun, newestRunPrefix } = await discoverRunBounds(basePrefix, bucketRoot);
  if (!firstRun) {
    throw new Error(`[Discovery] No runs found for ${model}`);
  }

  // 3. Check if there's an incomplete run newer than completed
  let incompleteRunTimesteps: string[] | null = null;
  let incompleteRunPrefix: string | null = null;

  if (newestRun && newestRun > completedRunTime) {
    // Incomplete run exists - list its files to see what's available
    const files = await listS3Files(newestRunPrefix!, bucketRoot);
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
  const lastCompleteRun = incompleteRunTimesteps ? completedRunTime : (newestRun ?? completedRunTime);  // QC-OK: fallback if no runs
  const runs = generateRuns(basePrefix, firstRun, lastCompleteRun);

  // 5. Generate timesteps
  const timesteps = generateTimesteps(
    runs,
    completedRunTime,
    completedValidTimes,
    incompleteRunPrefix,
    incompleteRunTimesteps,
    bucketRoot,
    basePrefix
  );

  return { timesteps, variables };
}

// ─────────────────────────────────────────────────────────────────────────────
// S3 Listing Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function discoverRunBounds(basePrefix: string, bucketRoot: string): Promise<{
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
    const days = await listS3Prefixes(`${basePrefix}${yearMonth}/`, bucketRoot);
    dayPrefixes.push(...days);
  }
  dayPrefixes.sort();

  if (dayPrefixes.length === 0) {
    return { firstRun: null, newestRun: null, newestRunPrefix: null };
  }

  // List oldest day runs
  const oldestDayRuns = await listS3Prefixes(dayPrefixes[0]!, bucketRoot);
  if (oldestDayRuns.length === 0) {
    return { firstRun: null, newestRun: null, newestRunPrefix: null };
  }
  const firstRunMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}Z)\/$/.exec(oldestDayRuns[0]!);

  // List newest day runs
  const newestDayRuns = await listS3Prefixes(dayPrefixes[dayPrefixes.length - 1]!, bucketRoot);
  if (newestDayRuns.length === 0) {
    return { firstRun: null, newestRun: null, newestRunPrefix: null };
  }
  const newestRunMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}Z)\/$/.exec(newestDayRuns[newestDayRuns.length - 1]!);

  const parseRun = (match: RegExpExecArray | null) =>
    match ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]!.slice(0, 2)}:00:00Z`) : null;

  return {
    firstRun: parseRun(firstRunMatch),
    newestRun: parseRun(newestRunMatch),
    newestRunPrefix: newestRunMatch ? newestDayRuns[newestDayRuns.length - 1]! : null,
  };
}

async function listS3Prefixes(prefix: string, bucketRoot: string): Promise<string[]> {
  const url = `${bucketRoot}?list-type=2&prefix=${prefix}&delimiter=/`;
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

async function listS3Files(prefix: string, bucketRoot: string): Promise<string[]> {
  const url = `${bucketRoot}?list-type=2&prefix=${prefix}`;
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

// ─────────────────────────────────────────────────────────────────────────────
// Run & Timestep Generation
// ─────────────────────────────────────────────────────────────────────────────

/** Build run prefix for a given datetime (e.g. data_spatial/ecmwf_ifs/2026/02/21/0600Z/) */
function runPrefixForDate(basePrefix: string, datetime: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const y = datetime.getUTCFullYear();
  const m = pad(datetime.getUTCMonth() + 1);
  const d = pad(datetime.getUTCDate());
  const h = pad(datetime.getUTCHours());
  return `${basePrefix}${y}/${m}/${d}/${h}00Z/`;
}

function generateRuns(basePrefix: string, firstRun: Date, lastRun: Date): ModelRun[] {
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

function generateTimesteps(
  runs: ModelRun[],
  completedRunTime: Date,
  completedValidTimes: string[],
  incompleteRunPrefix: string | null,
  incompleteRunTimesteps: string[] | null,
  bucketRoot: string,
  basePrefix: string
): Timestep[] {
  const timesteps: Timestep[] = [];
  const seen = new Set<TTimestep>();
  const GAP_FILL_HOURS = [0, 1, 2, 3, 4, 5]; // First 6 hours from older runs

  // 1. Add incomplete run timesteps first (highest priority)
  //    isAnalysis: true for T+0 (timestep matches run start) — backward sum params undefined there
  if (incompleteRunPrefix && incompleteRunTimesteps) {
    const runMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})00Z\/$/.exec(incompleteRunPrefix);
    if (!runMatch) {
      console.error(`[Discovery] Invalid run prefix format: ${incompleteRunPrefix}`);
      throw new Error('Weather data server returned unexpected format');
    }
    const runTime = `${runMatch[4]}00Z`;
    const incompleteRunDate = new Date(`${runMatch[1]}-${runMatch[2]}-${runMatch[3]}T${runMatch[4]}:00:00Z`);
    const incompleteRunStart = formatTimestep(incompleteRunDate);
    // Previous run's prefix — backward sum params use this at T+0 (where this time is T+6)
    const incompletePrevPrefix = runPrefixForDate(basePrefix, new Date(incompleteRunDate.getTime() - 6 * 3600000));

    for (const tsStr of incompleteRunTimesteps) {
      const ts = tsStr as TTimestep;
      if (!seen.has(ts)) {
        const isT0 = ts === incompleteRunStart;
        timesteps.push({
          index: 0,
          timestep: ts,
          run: runTime,
          url: `${bucketRoot}/${incompleteRunPrefix}${ts}.om`,
          isAnalysis: isT0,
          ...(isT0 && { fallbackUrl: `${bucketRoot}/${incompletePrevPrefix}${ts}.om` }),
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
      // isAnalysis: true for T+0 (first valid_time matching reference_time)
      // fallbackUrl: previous run's file where this time is T+6 (backward sums defined)
      const completedRunTs = formatTimestep(completedRunTime);
      const completedPrevPrefix = runPrefixForDate(basePrefix, new Date(completedRunTime.getTime() - 6 * 3600000));
      for (const isoTime of completedValidTimes) {
        const ts = formatTimestep(new Date(isoTime));
        if (!seen.has(ts)) {
          const isT0 = ts === completedRunTs;
          timesteps.push({
            index: 0,
            timestep: ts,
            run: run.run,
            url: `${bucketRoot}/${run.prefix}${ts}.om`,
            isAnalysis: isT0,
            ...(isT0 && { fallbackUrl: `${bucketRoot}/${completedPrevPrefix}${ts}.om` }),
          });
          seen.add(ts);
        }
      }
    } else {
      // Older runs: compute gap-fill timesteps (first 6 hours)
      // isAnalysis: true for hours===0 (T+0) — backward sum params undefined there
      // fallbackUrl: previous run's file where this time is T+6
      const gapFillPrevPrefix = runPrefixForDate(basePrefix, new Date(run.datetime.getTime() - 6 * 3600000));
      for (const hours of GAP_FILL_HOURS) {
        const tsDate = new Date(run.datetime.getTime() + hours * 60 * 60 * 1000);
        const ts = formatTimestep(tsDate);
        if (!seen.has(ts)) {
          timesteps.push({
            index: 0,
            timestep: ts,
            run: run.run,
            url: `${bucketRoot}/${run.prefix}${ts}.om`,
            isAnalysis: hours === 0,
            ...(hours === 0 && { fallbackUrl: `${bucketRoot}/${gapFillPrevPrefix}${ts}.om` }),
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
