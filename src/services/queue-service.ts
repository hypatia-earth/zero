/**
 * QueueService - Download queue with progress tracking
 *
 * Fetches files sequentially with streaming chunks for accurate ETA.
 * Single source of truth for all pending downloads.
 */

import type { FileOrder, QueueStats, IQueueService } from '../config/types';

export class QueueService implements IQueueService {
  stats: QueueStats = {
    bytesQueued: 0,
    bytesCompleted: 0,
    bytesPerSec: undefined,
    etaSeconds: undefined,
    status: 'idle',
  };

  private samples: Array<{ timestamp: number; bytes: number }> = [];

  async submitFileOrders(
    orders: FileOrder[],
    onProgress?: (index: number, total: number) => void
  ): Promise<ArrayBuffer[]> {
    // Add to queued bytes
    for (const order of orders) {
      this.stats.bytesQueued += order.size;
    }
    this.stats.status = 'downloading';

    // Fetch sequentially
    const results: ArrayBuffer[] = [];
    let i = 0;
    for (const order of orders) {
      onProgress?.(i++, orders.length);
      const buffer = await this.fetchWithProgress(order.url);
      results.push(buffer);
    }

    this.stats.status = 'idle';
    return results;
  }

  private async fetchWithProgress(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      this.onChunk(value.length);
    }

    return this.combineChunks(chunks);
  }

  private onChunk(bytes: number): void {
    this.stats.bytesCompleted += bytes;
    this.samples.push({ timestamp: performance.now(), bytes });
    this.pruneOldSamples();
    this.updateBandwidth();
  }

  private pruneOldSamples(): void {
    const cutoff = performance.now() - 10_000; // 10s window
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
  }

  private updateBandwidth(): void {
    if (this.samples.length < 2) {
      this.stats.bytesPerSec = undefined;
      this.stats.etaSeconds = undefined;
      return;
    }

    const first = this.samples[0]!;
    const duration = (performance.now() - first.timestamp) / 1000;
    if (duration < 0.5) return; // Need at least 0.5s of data

    const totalBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    this.stats.bytesPerSec = totalBytes / duration;

    const remaining = this.stats.bytesQueued - this.stats.bytesCompleted;
    this.stats.etaSeconds = remaining / this.stats.bytesPerSec;
  }

  private combineChunks(chunks: Uint8Array[]): ArrayBuffer {
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }

  dispose(): void {
    this.samples = [];
  }
}
