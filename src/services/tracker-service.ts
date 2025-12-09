/**
 * TrackerService - Download bandwidth monitoring
 */

import { signal } from '@preact/signals-core';

export interface DownloadStats {
  bytesPerSec: number | undefined;
  totalBytes: number;
  status: 'idle' | 'downloading';
}

interface BandwidthSample {
  timestamp: number;
  bytes: number;
}

export class TrackerService {
  private static readonly WINDOW_MS = 10_000;
  private static readonly MIN_WINDOW_MS = 1_000;

  private samples: BandwidthSample[] = [];
  private totalBytesDownloaded = 0;

  readonly stats = signal<DownloadStats>({
    bytesPerSec: undefined,
    totalBytes: 0,
    status: 'idle',
  });

  onBytesReceived(bytes: number): void {
    const now = performance.now();
    this.samples.push({ timestamp: now, bytes });
    this.totalBytesDownloaded += bytes;
    this.pruneOldSamples(now);
    this.updateStats('downloading');
  }

  onDownloadComplete(): void {
    this.updateStats('idle');
  }

  getBytesPerSec(): number | undefined {
    const now = performance.now();
    this.pruneOldSamples(now);

    if (this.samples.length === 0) return undefined;

    const oldest = this.samples[0];
    if (!oldest) return undefined;

    const windowDuration = now - oldest.timestamp;
    if (windowDuration < TrackerService.MIN_WINDOW_MS) return undefined;

    const totalBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    return (totalBytes / windowDuration) * 1000;
  }

  getTotalBytes(): number {
    return this.totalBytesDownloaded;
  }

  private pruneOldSamples(now: number): void {
    const cutoff = now - TrackerService.WINDOW_MS;
    let cutoffIndex = 0;
    while (cutoffIndex < this.samples.length) {
      const sample = this.samples[cutoffIndex];
      if (!sample || sample.timestamp >= cutoff) break;
      cutoffIndex++;
    }
    if (cutoffIndex > 0) {
      this.samples = this.samples.slice(cutoffIndex);
    }
  }

  private updateStats(status: 'idle' | 'downloading'): void {
    this.stats.value = {
      bytesPerSec: this.getBytesPerSec(),
      totalBytes: this.totalBytesDownloaded,
      status,
    };
  }

  reset(): void {
    this.samples = [];
    this.totalBytesDownloaded = 0;
    this.updateStats('idle');
  }
}
