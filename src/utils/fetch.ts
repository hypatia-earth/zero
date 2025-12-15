/**
 * Fetch utilities - Centralized HTTP fetching
 *
 * All network requests go through these functions to enable:
 * - Consistent error handling
 * - Layer-based SW caching via X-Layer header
 */

/** Layer identifier for SW caching */
export type CacheLayer = 'temp' | 'wind' | 'rain' | 'pressure' | 'meta';

/**
 * Simple GET fetch, returns ArrayBuffer
 * Used for: WASM, LUTs, basemap PNGs
 */
export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.arrayBuffer();
}

/**
 * Streaming GET fetch with chunk progress reporting
 * Used by QueueService for bandwidth tracking during bootstrap
 */
export async function fetchStreaming(
  url: string,
  headers: HeadersInit,
  onChunk: (bytes: number) => void
): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk(value.length);
  }

  // Combine chunks into single ArrayBuffer
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

/**
 * Range GET fetch, returns Uint8Array
 * Used for: .om file partial reads
 * @param layer - Layer identifier for SW cache segregation
 */
export async function fetchRange(
  url: string,
  offset: number,
  size: number,
  layer: CacheLayer = 'meta'
): Promise<Uint8Array> {
  const headers: HeadersInit = {
    Range: `bytes=${offset}-${offset + size - 1}`,
    'X-Layer': layer,
  };
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} fetching range ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * HEAD request, returns content-length
 * Used for: .om file size discovery
 */
export async function fetchHead(url: string): Promise<number> {
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

/**
 * Suffix range GET fetch, returns last N bytes
 * Uses HTTP suffix range (bytes=-N) to get last N bytes without knowing file size
 * Used for: .om trailer fetch (saves HEAD roundtrip)
 */
export async function fetchSuffix(
  url: string,
  suffixBytes: number,
  layer: CacheLayer = 'meta'
): Promise<Uint8Array> {
  const headers: HeadersInit = {
    Range: `bytes=-${suffixBytes}`,
    'X-Layer': layer,
  };
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} fetching suffix ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
