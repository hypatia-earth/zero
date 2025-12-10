/**
 * DataService - Fetch weather data from Open-Meteo S3
 *
 * Uses OmFileAdapter for direct WASM-based .om file reading.
 *
 * Timestep logic:
 * - Data window: wall time ±5 days (11 days total), always 00:00 to 00:00
 * - For any target time T, find the model run R at or before T
 * - URL: {run_date}/{run}00Z/{target_timestamp}.om
 */

import { readOmVariable, initOmWasm } from '../adapters/om-file-adapter';
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

function getRunForTimestamp(targetTime: Date, latestRun: Date): Date {
  const runHour = Math.floor(targetTime.getUTCHours() / 6) * 6;
  const runTime = new Date(targetTime);
  runTime.setUTCHours(runHour, 0, 0, 0);
  return runTime > latestRun ? latestRun : runTime;
}

function buildOmUrl(targetTime: Date, latestRun: Date): string {
  const run = getRunForTimestamp(targetTime, latestRun);
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
  offset: number;
  loadedPoints: number;
  totalPoints: number;
  bytesPerSecond: number;
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
    // Pre-init WASM
    await initOmWasm();
    this.latestRun = await findLatestRun();
    const window = getDataWindow();
    console.log(`[Data] Initialized: latest run ${this.latestRun.toISOString()}`);
    console.log(`[Data] Data window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
  }

  getLatestRun(): Date | null {
    return this.latestRun;
  }

  getDataWindow(): { start: Date; end: Date } {
    return getDataWindow();
  }

  /**
   * Load temperature data for two adjacent timesteps
   */
  async loadProgressiveInterleaved(time: Date, onProgress: ProgressCallback): Promise<TempData> {
    if (this.loadingAbort) this.loadingAbort.abort();
    this.loadingAbort = new AbortController();

    if (!this.latestRun) throw new Error('DataService not initialized');

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);
    const url0 = buildOmUrl(time0, this.latestRun);
    const url1 = buildOmUrl(time1, this.latestRun);

    console.log(`[Data] Loading: ${time0.toISOString()} - ${time1.toISOString()}`);
    console.log(`[Data] URL0: ${url0}`);
    console.log(`[Data] URL1: ${url1}`);

    const t0 = performance.now();

    // Fetch both timesteps in parallel using adapter
    const [result0, result1] = await Promise.all([
      readOmVariable(url0, 'temperature_2m', DEFAULT_SLICES, (p) => {
        console.log(`[Data] T0 ${p.phase}: ${p.loaded}/${p.total}`);
      }),
      readOmVariable(url1, 'temperature_2m', DEFAULT_SLICES, (p) => {
        console.log(`[Data] T1 ${p.phase}: ${p.loaded}/${p.total}`);
      }),
    ]);

    const elapsed = (performance.now() - t0) / 1000;
    const totalBytes = (result0.data.byteLength + result1.data.byteLength);
    console.log(`[Data] Complete: ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${elapsed.toFixed(1)}s`);

    this.tempData = {
      time0,
      time1,
      data0: result0.data,
      data1: result1.data,
      loadedPoints: result0.data.length,
    };

    this.trackerService.onBytesReceived(totalBytes);
    this.trackerService.onDownloadComplete();

    // Single progress callback with full data
    onProgress({
      data0: result0.data,
      data1: result1.data,
      offset: 0,
      loadedPoints: result0.data.length,
      totalPoints: result0.data.length,
      bytesPerSecond: totalBytes / elapsed,
    });

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
