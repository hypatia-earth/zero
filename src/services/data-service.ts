/**
 * DataService - Fetch weather data from Open-Meteo S3
 *
 * Progressive interleaved loading: fetches chunks from both timesteps
 * alternately so interpolated rendering can begin immediately.
 */

import { OmFileReader, OmHttpBackend, OmDataType } from '@openmeteo/file-reader';
import type { TrackerService } from './tracker-service';

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';
const TOTAL_POINTS = 6_599_680;

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
 * Build Open-Meteo URL for a given timestamp
 */
function buildOmUrl(time: Date): string {
  // Find model run (00Z, 06Z, 12Z, 18Z) - use the one at or before current hour
  const runHour = Math.floor(time.getUTCHours() / 6) * 6;
  const runDate = new Date(time);
  runDate.setUTCHours(runHour, 0, 0, 0);

  const year = runDate.getUTCFullYear();
  const month = String(runDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(runDate.getUTCDate()).padStart(2, '0');
  const run = String(runHour).padStart(2, '0');

  // Timestamp format: 2025-12-09T1200
  const ts = time.toISOString().slice(0, 13).replace('T', 'T') + '00';

  return `${BASE_URL}/${year}/${month}/${day}/${run}00Z/${ts}.om`;
}

/**
 * Get two adjacent hourly timestamps for interpolation
 */
function getAdjacentTimestamps(time: Date): [Date, Date] {
  const t0 = new Date(time);
  t0.setUTCMinutes(0, 0, 0);

  const t1 = new Date(t0);
  t1.setUTCHours(t1.getUTCHours() + 1);

  return [t0, t1];
}

/**
 * Create OmFileReader for a URL and find temperature variable
 */
async function createTempReader(url: string): Promise<OmFileReader> {
  console.log(`[Data] Opening: ${url}`);
  const backend = new OmHttpBackend({ url });
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

  constructor(trackerService: TrackerService) {
    this.trackerService = trackerService;
  }

  /**
   * Load temperature data progressively with interleaved chunks
   * Calls onProgress after each batch so UI can update
   */
  async loadProgressiveInterleaved(
    time: Date,
    onProgress: ProgressCallback
  ): Promise<TempData> {
    const [time0, time1] = getAdjacentTimestamps(time);

    // Abort any existing load
    if (this.loadingAbort) {
      this.loadingAbort.abort();
    }
    this.loadingAbort = new AbortController();

    console.log(`[Data] Progressive load: ${time0.toISOString()} - ${time1.toISOString()}`);

    // Create readers for both timesteps in parallel
    const [tempVar0, tempVar1] = await Promise.all([
      createTempReader(buildOmUrl(time0)),
      createTempReader(buildOmUrl(time1)),
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
      const batchSize = Math.max(
        10000, // Minimum batch
        Math.min(
          Math.floor(speed * 0.5),
          total - loaded
        )
      );

      const t = performance.now();

      // Fetch same region from BOTH timesteps in parallel
      const [chunk0, chunk1] = await Promise.all([
        tempVar0.read({
          type: OmDataType.FloatArray,
          ranges: [
            { start: 0, end: dims[0]! },
            { start: loaded, end: loaded + batchSize },
          ],
        }),
        tempVar1.read({
          type: OmDataType.FloatArray,
          ranges: [
            { start: 0, end: dims[0]! },
            { start: loaded, end: loaded + batchSize },
          ],
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

      // Callback for GPU upload and UI update
      onProgress({
        data0: chunk0,
        data1: chunk1,
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
    const [time0, time1] = getAdjacentTimestamps(time);

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
    if (!this.tempData) return true;

    const [time0, time1] = getAdjacentTimestamps(time);
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
