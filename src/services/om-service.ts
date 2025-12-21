/**
 * OmService - Open-Meteo .om file streaming with preflight
 *
 * Wraps om-file-adapter with preflight callback for QueueService integration.
 * Reports exact byte size after metadata phases, before data fetch.
 *
 * Supports worker pool for parallel decompression (pool of 1 = main thread).
 */

import type { IOmService, OmPreflight, OmSlice } from '../config/types';
import { streamOmVariable, preflightOmVariable } from '../adapters/om-file-adapter';
import { WorkerPool } from './worker-pool';

const DEFAULT_SLICES = 10;

export class OmService implements IOmService {
  private workerPool: WorkerPool | null = null;

  /**
   * Initialize worker pool for parallel decompression
   * @param wasmBinary - Pre-loaded WASM binary
   * @param poolSize - Number of workers (1 = main thread only)
   */
  async initWorkerPool(wasmBinary: ArrayBuffer, poolSize: number): Promise<void> {
    if (poolSize <= 1) {
      console.log('[OmService] Pool size 1, using main thread WASM');
      return;
    }

    this.workerPool = new WorkerPool(poolSize, wasmBinary);
    await this.workerPool.initialize();
  }

  /**
   * Preflight-only: get size info without fetching data
   * Used for bulk queue size calculation
   */
  async preflight(url: string, param: string): Promise<OmPreflight> {
    const result = await preflightOmVariable(url, param);
    return { totalBytes: result.totalBytes, chunks: result.chunks };
  }

  /**
   * Fetch data with byte progress tracking
   * Uses worker pool if initialized, otherwise main thread WASM
   * @param signal - Optional AbortSignal for cancellation
   */
  async fetch(
    url: string,
    param: string,
    onPreflight: (info: OmPreflight) => void,
    onSlice: (slice: OmSlice) => void,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal
  ): Promise<Float32Array> {
    // Use worker pool if available
    if (this.workerPool) {
      return this.workerPool.fetch(url, param, onPreflight, onSlice, onBytes, signal);
    }

    // Fallback to main thread WASM
    const result = await streamOmVariable(
      url,
      param,
      DEFAULT_SLICES,
      (chunk) => {
        onSlice({
          data: chunk.data,
          sliceIndex: chunk.sliceIndex,
          totalSlices: chunk.totalSlices,
          done: chunk.done,
        });
      },
      onPreflight,
      false,
      onBytes,
      signal
    );
    return result.data;
  }

  dispose(): void {
    this.workerPool?.dispose();
    this.workerPool = null;
  }
}
