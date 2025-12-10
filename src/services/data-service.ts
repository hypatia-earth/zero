/**
 * DataService - Fetch weather data from Open-Meteo S3
 *
 * Progressive interleaved loading: fetches chunks from both timesteps
 * alternately so interpolated rendering can begin immediately.
 *
 * Timestep logic:
 * - Data window: wall time ±5 days (11 days total), always 00:00 to 00:00
 * - For any target time T, find the model run R at or before T
 * - Offset = T - R (hours)
 * - URL: {run_date}/{run}00Z/{target_timestamp}.om
 * - For future times beyond latest run, use latest run + offset
 */

import { OmFileReader, OmHttpBackend, OmDataType, ReadProgressInfo } from '@openmeteo/file-reader';
import type { TrackerService } from './tracker-service';

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';
const S3_LIST_URL = 'https://openmeteo.s3.amazonaws.com/?list-type=2';
const TOTAL_POINTS = 6_599_680;
const MIN_BATCH_SIZE = 500_000; // ~2MB, prevents request overhead spiral
const DATA_WINDOW_DAYS = 5; // ±5 days from wall time

/**
 * Parse S3 listing XML to extract prefixes
 */
function parseS3Listing(xml: string): string[] {
  const prefixes: string[] = [];
  const regex = /<Prefix>([^<]+)<\/Prefix>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    if (match[1]) prefixes.push(match[1]);
  }
  return prefixes;
}

/**
 * Find latest available model run by listing S3
 */
async function findLatestRun(): Promise<Date> {
  // Get current year/month for listing
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  // List days in current month
  const daysUrl = `${S3_LIST_URL}&prefix=data_spatial/ecmwf_ifs/${year}/${month}/&delimiter=/`;
  const daysResponse = await fetch(daysUrl);
  const daysXml = await daysResponse.text();
  const days = parseS3Listing(daysXml).filter(p => p.endsWith('/') && p.includes(`/${month}/`));

  if (days.length === 0) {
    throw new Error('No data available in S3');
  }

  // Get latest day (last in sorted list)
  const latestDayPrefix = days[days.length - 1];
  console.log(`[Data] Latest day: ${latestDayPrefix}`);

  // List runs for that day
  const runsUrl = `${S3_LIST_URL}&prefix=${latestDayPrefix}&delimiter=/`;
  const runsResponse = await fetch(runsUrl);
  const runsXml = await runsResponse.text();
  const runs = parseS3Listing(runsXml).filter(p => p.endsWith('Z/'));

  if (runs.length === 0) {
    throw new Error(`No runs available for ${latestDayPrefix}`);
  }

  // Get latest run (last in sorted list: 0000Z, 0600Z, 1200Z, 1800Z)
  const latestRunPrefix = runs[runs.length - 1]!;
  console.log(`[Data] Latest run: ${latestRunPrefix}`);

  // Parse: data_spatial/ecmwf_ifs/2025/12/09/1800Z/
  const match = latestRunPrefix.match(/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})00Z/);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4]) {
    throw new Error(`Cannot parse run prefix: ${latestRunPrefix}`);
  }

  return new Date(Date.UTC(
    parseInt(match[1]),
    parseInt(match[2]) - 1,
    parseInt(match[3]),
    parseInt(match[4]),
    0, 0, 0
  ));
}

/**
 * Get data window bounds (wall time ±5 days, aligned to 00:00)
 */
function getDataWindow(): { start: Date; end: Date } {
  const now = new Date();

  // Start: today - 5 days at 00:00
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - DATA_WINDOW_DAYS,
    0, 0, 0, 0
  ));

  // End: today + 5 days at 00:00 (exclusive, so +6 days)
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + DATA_WINDOW_DAYS + 1,
    0, 0, 0, 0
  ));

  return { start, end };
}

/**
 * Find the model run to use for a given target timestamp
 */
function getRunForTimestamp(targetTime: Date, latestRun: Date): Date {
  // Round down to nearest 6-hour boundary (00, 06, 12, 18)
  const runHour = Math.floor(targetTime.getUTCHours() / 6) * 6;
  const runTime = new Date(targetTime);
  runTime.setUTCHours(runHour, 0, 0, 0);

  // If target is in future beyond latestRun, use latestRun
  if (runTime > latestRun) {
    return latestRun;
  }

  return runTime;
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

/**
 * Build Open-Meteo URL for a given timestamp using correct run
 * @param targetTime - The timestamp we want data for
 * @param latestRun - The latest available model run from S3 listing
 */
function buildOmUrl(targetTime: Date, latestRun: Date): string {
  // Find which run to use (at or before target, capped at latestRun)
  const run = getRunForTimestamp(targetTime, latestRun);

  const year = run.getUTCFullYear();
  const month = String(run.getUTCMonth() + 1).padStart(2, '0');
  const day = String(run.getUTCDate()).padStart(2, '0');
  const runHour = String(run.getUTCHours()).padStart(2, '0');

  // Timestamp format: 2025-12-09T1200
  const ts = targetTime.toISOString().slice(0, 13).replace('T', 'T') + '00';

  return `${BASE_URL}/${year}/${month}/${day}/${runHour}00Z/${ts}.om`;
}

/**
 * Get timestep resolution based on forecast offset
 * 0-90h: 1-hourly, 90-144h: 3-hourly, 144h+: 6-hourly
 */
function getTimestepResolution(targetTime: Date, latestRun: Date): number {
  const offsetHours = (targetTime.getTime() - latestRun.getTime()) / (1000 * 60 * 60);
  if (offsetHours <= 90) return 1;
  if (offsetHours <= 144) return 3;
  return 6;
}

/**
 * Get two adjacent timestamps for interpolation, respecting timestep resolution
 */
function getAdjacentTimestamps(time: Date, latestRun: Date): [Date, Date] {
  const resolution = getTimestepResolution(time, latestRun);

  const t0 = new Date(time);
  t0.setUTCMinutes(0, 0, 0);
  // Snap to resolution boundary
  const hour0 = Math.floor(t0.getUTCHours() / resolution) * resolution;
  t0.setUTCHours(hour0);

  const t1 = new Date(t0);
  t1.setUTCHours(t1.getUTCHours() + resolution);

  return [t0, t1];
}

/**
 * Create OmFileReader for a URL and find temperature variable
 */
async function createTempReader(url: string): Promise<OmFileReader> {
  console.log(`[Data] Opening: ${url}`);
  const backend = new OmHttpBackend({
    url,
    eTagValidation: false,  // Disable to allow browser caching
  });
  const reader = await OmFileReader.create(backend);

  const numChildren = reader.numberOfChildren();
  for (let i = 0; i < numChildren; i++) {
    const child = await reader.getChild(i);
    if (!child) continue;
    const name = child.getName();
    if (name === 'temperature_2m' || name === 'temperature') {
      return child;
    }
  }

  throw new Error(`No temperature variable found in ${url}`);
}

export class DataService {
  private tempData: TempData | null = null;
  private trackerService: TrackerService;
  private loadingAbort: AbortController | null = null;
  private latestRun: Date | null = null;

  constructor(trackerService: TrackerService) {
    this.trackerService = trackerService;
  }

  /**
   * Initialize by finding latest available run from S3
   * Must be called before loading data
   */
  async initialize(): Promise<void> {
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
   * Load temperature data progressively with interleaved chunks
   * Calls onProgress after each batch so UI can update
   */
  async loadProgressiveInterleaved(
    time: Date,
    onProgress: ProgressCallback
  ): Promise<TempData> {
    // Abort any existing load
    if (this.loadingAbort) {
      this.loadingAbort.abort();
    }
    this.loadingAbort = new AbortController();

    if (!this.latestRun) {
      throw new Error('DataService not initialized - call initialize() first');
    }

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);

    const url0 = buildOmUrl(time0, this.latestRun);
    const url1 = buildOmUrl(time1, this.latestRun);
    console.log(`[Data] Progressive load: ${time0.toISOString()} - ${time1.toISOString()}`);

    // Create readers for both timesteps in parallel
    const [tempVar0, tempVar1] = await Promise.all([
      createTempReader(url0),
      createTempReader(url1),
    ]);

    const dims = tempVar0.getDimensions();
    const total = dims[1] ?? TOTAL_POINTS;

    // Pre-allocate full buffers
    const data0 = new Float32Array(total);
    const data1 = new Float32Array(total);

    // Initialize TempData with 0 loaded points
    this.tempData = { time0, time1, data0, data1, loadedPoints: 0 };

    // Dynamic batch sizing - target 1 second per update
    let loaded = 0;
    let speed = 50000; // Initial estimate: 50k points/sec

    while (loaded < total) {
      // Check for abort
      if (this.loadingAbort.signal.aborted) {
        throw new Error('Load aborted');
      }

      // Dynamic batch = ~0.5s worth per timestep (1s total for both)
      // Remaining points caps the batch size (fixes last chunk)
      const remaining = total - loaded;
      const batchSize = Math.min(
        remaining,
        Math.max(MIN_BATCH_SIZE, Math.floor(speed * 0.5))
      );

      const t = performance.now();

      // Progress callback for library-level streaming info
      const logLibProgress = (info: ReadProgressInfo) => {
        console.log(`[Data] Lib progress:`, info);
      };

      // Fetch same region from BOTH timesteps in parallel
      const [chunk0, chunk1] = await Promise.all([
        tempVar0.read({
          type: OmDataType.FloatArray,
          ranges: [
            { start: 0, end: dims[0]! },
            { start: loaded, end: loaded + batchSize },
          ],
          onProgress: logLibProgress,
        }),
        tempVar1.read({
          type: OmDataType.FloatArray,
          ranges: [
            { start: 0, end: dims[0]! },
            { start: loaded, end: loaded + batchSize },
          ],
          onProgress: logLibProgress,
        }),
      ]);

      // Copy chunks into full buffers
      data0.set(chunk0, loaded);
      data1.set(chunk1, loaded);

      // Update speed estimate (smoothed)
      const elapsed = (performance.now() - t) / 1000;
      if (elapsed > 0.1) {
        speed = speed * 0.7 + (batchSize / elapsed) * 0.3;
      }

      loaded += batchSize;
      this.tempData.loadedPoints = loaded;

      // Track bytes
      this.trackerService.onBytesReceived(chunk0.byteLength + chunk1.byteLength);

      // Small delay to let GPU process previous uploads
      await new Promise(resolve => setTimeout(resolve, 4));

      // Callback for GPU upload and UI update (copy chunks to avoid reuse issues)
      onProgress({
        data0: new Float32Array(chunk0),
        data1: new Float32Array(chunk1),
        offset: loaded - batchSize,
        loadedPoints: loaded,
        totalPoints: total,
        bytesPerSecond: speed * 4 * 2, // Float32 * 2 timesteps
      });

      console.log(`[Data] Progress: ${((loaded / total) * 100).toFixed(1)}% (${(speed / 1000).toFixed(0)}k pts/s)`);
    }

    this.trackerService.onDownloadComplete();
    console.log(`[Data] Complete: ${total.toLocaleString()} points x2`);

    return this.tempData;
  }

  /**
   * Simple non-progressive load (for fallback/testing)
   */
  async loadTempForTime(time: Date): Promise<TempData> {
    if (!this.latestRun) {
      throw new Error('DataService not initialized');
    }

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);

    if (this.tempData &&
        this.tempData.time0.getTime() === time0.getTime() &&
        this.tempData.time1.getTime() === time1.getTime() &&
        this.tempData.loadedPoints === TOTAL_POINTS) {
      return this.tempData;
    }

    // Use progressive loading with no-op callback
    return this.loadProgressiveInterleaved(time, () => {});
  }

  getTempData(): TempData | null {
    return this.tempData;
  }

  getLoadedPoints(): number {
    return this.tempData?.loadedPoints ?? 0;
  }

  /**
   * Calculate interpolation factor for current time
   */
  getTempInterpolation(currentTime: Date): number {
    if (!this.tempData) return 0;

    const t0 = this.tempData.time0.getTime();
    const t1 = this.tempData.time1.getTime();
    const tc = currentTime.getTime();

    if (tc <= t0) return 0;
    if (tc >= t1) return 1;

    return (tc - t0) / (t1 - t0);
  }

  /**
   * Check if we need to load new data for the given time
   */
  needsLoad(time: Date): boolean {
    if (!this.tempData || !this.latestRun) return true;

    const [time0, time1] = getAdjacentTimestamps(time, this.latestRun);
    return this.tempData.time0.getTime() !== time0.getTime() ||
           this.tempData.time1.getTime() !== time1.getTime();
  }

  /**
   * Abort current loading
   */
  abort(): void {
    if (this.loadingAbort) {
      this.loadingAbort.abort();
      this.loadingAbort = null;
    }
  }
}
