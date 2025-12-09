/**
 * DataService - Load weather data for GPU upload
 */

export interface TempData {
  time0: Date;
  time1: Date;
  data0: Float32Array;
  data1: Float32Array;
}

export class DataService {
  private tempData: TempData | null = null;

  async loadTempData(url0: string, url1: string, time0: Date, time1: Date): Promise<TempData> {
    console.log(`[Data] Loading temp data...`);
    const t0 = performance.now();

    const [resp0, resp1] = await Promise.all([
      fetch(url0),
      fetch(url1)
    ]);

    if (!resp0.ok || !resp1.ok) {
      throw new Error(`Failed to fetch temp data: ${resp0.status}, ${resp1.status}`);
    }

    const [buf0, buf1] = await Promise.all([
      resp0.arrayBuffer(),
      resp1.arrayBuffer()
    ]);

    const data0 = new Float32Array(buf0);
    const data1 = new Float32Array(buf1);

    console.log(`[Data] Loaded ${data0.length.toLocaleString()} points x2 in ${(performance.now() - t0).toFixed(0)}ms`);

    this.tempData = { time0, time1, data0, data1 };
    return this.tempData;
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
}
