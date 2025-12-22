/**
 * OmService - Open-Meteo .om file streaming with preflight
 *
 * Wraps om-file-adapter with preflight callback for QueueService integration.
 * Reports exact byte size after metadata phases, before data fetch.
 * Uses worker pool for parallel decompression (minimum 1 worker).
 */

import type { IOmService, OmPreflight, OmSlice } from '../config/types';
import { preflightOmVariable } from '../adapters/om-file-adapter';
import { WorkerPool } from './worker-pool';
import type { OptionsService } from './options-service';

export class OmService implements IOmService {
  private workerPool: WorkerPool | null = null;
  private optionsService: OptionsService;

  constructor(optionsService: OptionsService) {
    this.optionsService = optionsService;
  }

  /**
   * Initialize worker pool for parallel decompression
   * @param wasmBinary - Pre-loaded WASM binary
   */
  async init(wasmBinary: ArrayBuffer): Promise<void> {
    const poolSize = Math.max(1, parseInt(this.optionsService.options.value.gpu.workerPoolSize, 10));
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
    return this.workerPool!.fetch(url, param, onPreflight, onSlice, onBytes, signal);
  }

  dispose(): void {
    this.workerPool?.dispose();
    this.workerPool = null;
  }
}
