/**
 * OmService - Open-Meteo .om file streaming with preflight
 *
 * Wraps om-file-adapter with preflight callback for QueueService integration.
 * Reports exact byte size after metadata phases, before data fetch.
 */

import type { IOmService, OmPreflight, OmSlice } from '../config/types';
import type { FetchService } from './fetch-service';
import { streamOmVariable } from '../adapters/om-file-adapter';

const DEFAULT_SLICES = 10;

export class OmService implements IOmService {
  constructor(private fetchService: FetchService) {}

  async fetch(
    url: string,
    param: string,
    onPreflight: (info: OmPreflight) => void,
    onSlice: (slice: OmSlice) => void
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
      this.fetchService,
      onPreflight
    );
    return result.data;
  }
}
