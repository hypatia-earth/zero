/**
 * FetchService - Centralized HTTP fetching with bandwidth tracking
 *
 * All network requests go through this service to enable:
 * - Bandwidth monitoring via TrackerService
 * - Sequential fetch queue (one request at a time during bootstrap)
 * - Consistent error handling
 * - Layer-based SW caching via X-Layer header
 */

import type { TrackerService } from './tracker-service';

/** Layer identifier for SW caching */
export type CacheLayer = 'temp' | 'wind' | 'rain' | 'pressure' | 'meta';

export class FetchService {
  constructor(private tracker: TrackerService) {}

  /**
   * Simple GET fetch, returns ArrayBuffer
   * Used for: WASM, LUTs, basemap PNGs
   */
  async fetch(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    const buffer = await response.arrayBuffer();
    this.tracker.onBytesReceived(buffer.byteLength);
    return buffer;
  }

  /**
   * Range GET fetch, returns Uint8Array
   * Used for: .om file partial reads
   * @param layer - Layer identifier for SW cache segregation
   */
  async fetchRange(url: string, offset: number, size: number, layer: CacheLayer = 'meta'): Promise<Uint8Array> {
    const headers: HeadersInit = {
      Range: `bytes=${offset}-${offset + size - 1}`,
      'X-Layer': layer,
    };
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} fetching range ${url}`);
    }
    const buffer = await response.arrayBuffer();
    this.tracker.onBytesReceived(buffer.byteLength);
    return new Uint8Array(buffer);
  }

  /**
   * HEAD request, returns content-length
   * Used for: .om file size discovery
   */
  async fetchHead(url: string): Promise<number> {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} HEAD ${url}`);
    }
    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
      throw new Error(`No content-length header for ${url}`);
    }
    return parseInt(contentLength, 10);
  }
}
