/**
 * OmService - Open-Meteo .om file streaming with preflight
 *
 * Wraps om-file-adapter with preflight callback for QueueService integration.
 * Reports exact byte size after metadata phases, before data fetch.
 */

import type { IOmService, OmPreflight, OmSlice } from '../config/types';
import { streamOmVariable, preflightOmVariable } from '../adapters/om-file-adapter';

const DEFAULT_SLICES = 10;

export class OmService implements IOmService {

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
}
