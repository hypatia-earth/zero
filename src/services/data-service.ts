/**
 * DataService - Fetch weather data from Open-Meteo S3
 *
 * Uses OmFileAdapter for direct WASM-based .om file reading.
 * Supports progressive streaming: fetch slice → decode → render → repeat
 *
 * Timestep logic:
 * - Data window: wall time ±5 days (11 days total), always 00:00 to 00:00
 * - For any target time T, find the model run R at or before T
 * - URL: {run_date}/{run}00Z/{target_timestamp}.om
 */

import { streamOmVariable, initOmWasm, type OmChunkData } from '../adapters/om-file-adapter';
import type { TrackerService } from './tracker-service';

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';
const S3_LIST_URL = 'https://openmeteo.s3.amazonaws.com/?list-type=2';
const TOTAL_POINTS = 6_599_680;
const DATA_WINDOW_DAYS = 5;
const DEFAULT_SLICES = 10;

function parseS3Listing(xml: string): string[] {
  const prefixes: string[] = [];
  const regex = /<Prefix>([^<]+)<\/Prefix>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    if (match[1]) prefixes.push(match[1]);
  }
  return prefixes;
}

async function findLatestRun(): Promise<Date> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  const daysUrl = `${S3_LIST_URL}&prefix=data_spatial/ecmwf_ifs/${year}/${month}/&delimiter=/`;
  const daysResponse = await fetch(daysUrl);
  const daysXml = await daysResponse.text();
  const days = parseS3Listing(daysXml).filter(p => p.endsWith('/') && p.includes(`/${month}/`));

  if (days.length === 0) throw new Error('No data available in S3');

  const latestDayPrefix = days[days.length - 1]!;
  console.log(`[Data] Latest day: ${latestDayPrefix}`);

  const runsUrl = `${S3_LIST_URL}&prefix=${latestDayPrefix}&delimiter=/`;
  const runsResponse = await fetch(runsUrl);
  const runsXml = await runsResponse.text();
  const runs = parseS3Listing(runsXml).filter(p => p.endsWith('Z/'));

  if (runs.length === 0) throw new Error(`No runs available for ${latestDayPrefix}`);

  const latestRunPrefix = runs[runs.length - 1]!;
  console.log(`[Data] Latest run: ${latestRunPrefix}`);

  const match = latestRunPrefix.match(/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})00Z/);
  if (!match) throw new Error(`Cannot parse run prefix: ${latestRunPrefix}`);

  return new Date(Date.UTC(
    parseInt(match[1]!), parseInt(match[2]!) - 1, parseInt(match[3]!), parseInt(match[4]!), 0, 0, 0
  ));
}

function getDataWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - DATA_WINDOW_DAYS, 0, 0, 0, 0
  ));
  const end = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + DATA_WINDOW_DAYS + 1, 0, 0, 0, 0
  ));
  return { start, end };
}

function buildOmUrl(targetTime: Date, latestRun: Date): string {
  // For forecast (target >= run), use latestRun
  // For analysis (target < run), need to find a run that was before targetTime
  let run: Date;
  if (targetTime >= latestRun) {
    run = latestRun;
  } else {
    // Target is in the past - find appropriate run
    // Use the 00Z/06Z/12Z/18Z run that is at or before targetTime
    run = new Date(targetTime);
    const runHour = Math.floor(targetTime.getUTCHours() / 6) * 6;
    run.setUTCHours(runHour, 0, 0, 0);
  }

  const year = run.getUTCFullYear();
  const month = String(run.getUTCMonth() + 1).padStart(2, '0');
  const day = String(run.getUTCDate()).padStart(2, '0');
  const runHour = String(run.getUTCHours()).padStart(2, '0');
  const ts = targetTime.toISOString().slice(0, 13).replace('T', 'T') + '00';
  return `${BASE_URL}/${year}/${month}/${day}/${runHour}00Z/${ts}.om`;
}

function getTimestepResolution(targetTime: Date, latestRun: Date): number {
  const offsetHours = (targetTime.getTime() - latestRun.getTime()) / (1000 * 60 * 60);
  if (offsetHours <= 90) return 1;
  if (offsetHours <= 144) return 3;
  return 6;
}

function getAdjacentTimestamps(time: Date, latestRun: Date): [Date, Date] {
  const resolution = getTimestepResolution(time, latestRun);
  const t0 = new Date(time);
  t0.setUTCMinutes(0, 0, 0);
  const hour0 = Math.floor(t0.getUTCHours() / resolution) * resolution;
  t0.setUTCHours(hour0);
  const t1 = new Date(t0);
  t1.setUTCHours(t1.getUTCHours() + resolution);
  return [t0, t1];
}

export interface ProgressUpdate {
  data0: Float32Array;
  data1: Float32Array;
  sliceIndex: number;
  totalSlices: number;
  done: boolean;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

export interface TempData {
  time0: Date;
  time1: Date;
  data0: Float32Array;
  data1: Float32Array;
  loadedPoints: number;
}

export class DataService {
  private tempData: TempData | null = null;
  private trackerService: TrackerService;
  private loadingAbort: AbortController | null = null;
  private latestRun: Date | null = null;

  constructor(trackerService: TrackerService) {
    this.trackerService = trackerService;
  }

  async initialize(): Promise<void> {
    await initOmWasm();
    this.latestRun = await findLatestRun();
    const window = getDataWindow();
    console.log(`[Data] Initialized: latest run ${this.latestRun.toISOString()}`);
    console.log(`[Data] Data window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
  }

  getLatestRun(): Date | null {
    return this.latestRun;
  }

  /**
   * Get timestamps for the pair bracketing the given time
   */
  getAdjacentTimestamps(time: Date): [Date, Date] {
    if (!this.latestRun) throw new Error('DataService not initialized');
    return getAdjacentTimestamps(time, this.latestRun);
  }

  getDataWindow(): { start: Date; end: Date } {
    return getDataWindow();
  }

  /**
   * Load temperature data with progressive streaming
   * Fetches both timesteps in parallel, calls onProgress after each slice
   */
  async loadProgressiveInterleaved(time: Date, onProgress: ProgressCallback): Promise<TempData> {
    if (this.loadingAbort) this.loadingAbort.abort();
    this.loadingAbort = new AbortController();

    if (!this.latestRun) throw new Error('DataService not initialized');

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);
    const url0 = buildOmUrl(time0, this.latestRun);
    const url1 = buildOmUrl(time1, this.latestRun);

    console.log(`[Data] Loading: ${time0.toISOString()} - ${time1.toISOString()}`);

    const t0 = performance.now();

    // Shared state for interleaved progress
    let data0: Float32Array | null = null;
    let data1: Float32Array | null = null;
    let slice0 = 0, slice1 = 0;

    const emitProgress = () => {
      if (data0 && data1) {
        const maxSlice = Math.max(slice0, slice1);
        onProgress({
          data0,
          data1,
          sliceIndex: maxSlice,
          totalSlices: DEFAULT_SLICES,
          done: slice0 >= DEFAULT_SLICES && slice1 >= DEFAULT_SLICES
        });
      }
    };

    // Stream both in parallel
    await Promise.all([
      streamOmVariable(url0, 'temperature_2m', DEFAULT_SLICES, (chunk: OmChunkData) => {
        data0 = chunk.data;
        slice0 = chunk.sliceIndex + 1;
        emitProgress();
      }),
      streamOmVariable(url1, 'temperature_2m', DEFAULT_SLICES, (chunk: OmChunkData) => {
        data1 = chunk.data;
        slice1 = chunk.sliceIndex + 1;
        emitProgress();
      })
    ]);

    const elapsed = (performance.now() - t0) / 1000;
    const totalBytes = (data0!.byteLength + data1!.byteLength);
    console.log(`[Data] Complete: ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${elapsed.toFixed(1)}s`);

    this.tempData = {
      time0,
      time1,
      data0: data0!,
      data1: data1!,
      loadedPoints: data0!.length,
    };

    this.trackerService.onBytesReceived(totalBytes);
    this.trackerService.onDownloadComplete();

    return this.tempData;
  }

  async loadTempForTime(time: Date): Promise<TempData> {
    if (!this.latestRun) throw new Error('DataService not initialized');

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);

    if (this.tempData &&
        this.tempData.time0.getTime() === time0.getTime() &&
        this.tempData.time1.getTime() === time1.getTime() &&
        this.tempData.loadedPoints === TOTAL_POINTS) {
      return this.tempData;
    }

    return this.loadProgressiveInterleaved(time, () => {});
  }

  /**
   * Load a single timestep's data
   * Returns the full Float32Array when complete
   */
  async loadSingleTimestep(
    timestamp: Date,
    onProgress?: (loadedPoints: number, done: boolean) => void
  ): Promise<Float32Array> {
    if (!this.latestRun) throw new Error('DataService not initialized');

    const url = buildOmUrl(timestamp, this.latestRun);
    console.log(`[Data] Loading single timestep: ${timestamp.toISOString()}`);

    let result: Float32Array | null = null;

    await streamOmVariable(url, 'temperature_2m', DEFAULT_SLICES, (chunk: OmChunkData) => {
      result = chunk.data;
      const done = chunk.sliceIndex + 1 >= DEFAULT_SLICES;
      onProgress?.(result.length, done);
    });

    if (!result) throw new Error(`Failed to load timestep: ${url}`);

    const data: Float32Array = result;
    this.trackerService.onBytesReceived(data.byteLength);
    return data;
  }

  getTempData(): TempData | null {
    return this.tempData;
  }

  getLoadedPoints(): number {
    return this.tempData?.loadedPoints ?? 0;
  }

  getTempInterpolation(currentTime: Date): number {
    if (!this.tempData) return 0;
    const t0 = this.tempData.time0.getTime();
    const t1 = this.tempData.time1.getTime();
    const tc = currentTime.getTime();
    if (tc <= t0) return 0;
    if (tc >= t1) return 1;
    return (tc - t0) / (t1 - t0);
  }

  needsLoad(time: Date): boolean {
    if (!this.tempData || !this.latestRun) return true;
    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);
    return this.tempData.time0.getTime() !== time0.getTime() ||
           this.tempData.time1.getTime() !== time1.getTime();
  }

  abort(): void {
    if (this.loadingAbort) {
      this.loadingAbort.abort();
      this.loadingAbort = null;
    }
  }
}
