/**
 * DataService - Fetch weather data from Open-Meteo S3
 *
 * Uses @openmeteo/file-reader to fetch only needed chunks via Range requests.
 * Tracks download progress for UI feedback.
 */

import { OmFileReader, OmHttpBackend, OmDataType } from '@openmeteo/file-reader';
import type { TrackerService } from './tracker-service';

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';

export interface TempTimestep {
  time: Date;
  data: Float32Array;
  status: 'pending' | 'loading' | 'loaded' | 'failed';
}

export interface TempData {
  time0: Date;
  time1: Date;
  data0: Float32Array;
  data1: Float32Array;
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

  // Timestamp format: 2025-12-09T12:00
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

export class DataService {
  private tempData: TempData | null = null;
  private trackerService: TrackerService;
  private loadingPromise: Promise<TempData> | null = null;

  constructor(trackerService: TrackerService) {
    this.trackerService = trackerService;
  }

  /**
   * Load temperature data for timestamps adjacent to given time
   */
  async loadTempForTime(time: Date): Promise<TempData> {
    const [time0, time1] = getAdjacentTimestamps(time);

    // Check if we already have this data
    if (this.tempData &&
        this.tempData.time0.getTime() === time0.getTime() &&
        this.tempData.time1.getTime() === time1.getTime()) {
      return this.tempData;
    }

    // Avoid concurrent loads
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    console.log(`[Data] Loading temp for ${time0.toISOString()} - ${time1.toISOString()}`);
    const t = performance.now();

    this.loadingPromise = (async () => {
      try {
        const [data0, data1] = await Promise.all([
          this.fetchTempTimestep(time0),
          this.fetchTempTimestep(time1),
        ]);

        this.tempData = { time0, time1, data0, data1 };
        console.log(`[Data] Loaded ${data0.length.toLocaleString()} points x2 in ${(performance.now() - t).toFixed(0)}ms`);

        return this.tempData;
      } finally {
        this.loadingPromise = null;
        this.trackerService.onDownloadComplete();
      }
    })();

    return this.loadingPromise;
  }

  /**
   * Fetch temperature data for a single timestep from Open-Meteo
   */
  private async fetchTempTimestep(time: Date): Promise<Float32Array> {
    const url = buildOmUrl(time);
    console.log(`[Data] Fetching: ${url}`);

    const backend = new OmHttpBackend({ url });
    const reader = await OmFileReader.create(backend);

    // Find temperature variable
    const numChildren = reader.numberOfChildren();
    let tempVar: OmFileReader | null = null;

    for (let i = 0; i < numChildren; i++) {
      const child = await reader.getChild(i);
      if (!child) continue;
      const name = child.getName();
      if (name === 'temperature_2m' || name === 'temperature') {
        tempVar = child;
        break;
      }
    }

    if (!tempVar) {
      throw new Error(`No temperature variable found in ${url}`);
    }

    const dims = tempVar.getDimensions();

    // Read all data - library fetches only needed chunks
    const data = await tempVar.read({
      type: OmDataType.FloatArray,
      ranges: [
        { start: 0, end: dims[0]! },
        { start: 0, end: dims[1]! },
      ],
    });

    // Track bytes (approximate - actual tracking would need backend wrapper)
    this.trackerService.onBytesReceived(data.byteLength);

    return data;
  }

  getTempData(): TempData | null {
    return this.tempData;
  }

  /**
   * Calculate interpolation factor for current time
   * Returns 0-1 between time0 and time1
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
}
