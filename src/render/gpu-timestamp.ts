/**
 * GPU timestamp query helper for render pass timing
 * Uses double-buffered read buffers to avoid mapAsync race conditions
 *
 * IMPORTANT: mapAsync must be called AFTER queue.submit(), otherwise
 * it may resolve immediately (no pending work) leaving buffer mapped
 * when the copy command executes.
 */

export class GpuTimestamp {
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private readBuffers: [GPUBuffer, GPUBuffer];
  private pending: [boolean, boolean] = [false, false];
  private lastTimeMs = NaN;
  private disposed = false;
  private activeIdx: 0 | 1 | -1 = -1;  // Buffer used this frame

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: 2,
    });

    this.resolveBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'timestamp-resolve',
    });

    this.readBuffers = [
      device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'timestamp-read-0' }),
      device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'timestamp-read-1' }),
    ];
  }

  /**
   * Check if timestamp-query feature is available
   */
  static isSupported(adapter: GPUAdapter): boolean {
    return adapter.features.has('timestamp-query');
  }

  /**
   * Get timestampWrites config for a render pass
   */
  getTimestampWrites(): GPURenderPassTimestampWrites {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /**
   * Encode resolve and copy commands. Call BEFORE queue.submit().
   */
  encodeResolve(encoder: GPUCommandEncoder): void {
    if (this.disposed) return;

    // Find a buffer that's not pending
    const idx: 0 | 1 | -1 = !this.pending[0] ? 0 : !this.pending[1] ? 1 : -1;
    if (idx === -1) {
      this.activeIdx = -1;
      return;
    }

    this.activeIdx = idx;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffers[idx], 0, 16);
  }

  /**
   * Start async readback. Call AFTER queue.submit().
   */
  startReadback(): void {
    if (this.disposed || this.activeIdx === -1) return;

    const idx = this.activeIdx;
    const readBuffer = this.readBuffers[idx];

    this.pending[idx] = true;
    readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const data = readBuffer.getMappedRange();
      const times = new BigUint64Array(data);
      const t0 = times[0]!, t1 = times[1]!;
      const durationNs = t1 > t0 ? Number(t1 - t0) : Number(t0 - t1);
      this.lastTimeMs = durationNs / 1_000_000;
      readBuffer.unmap();
      this.pending[idx] = false;
    }).catch(() => {
      this.pending[idx] = false;
    });

    this.activeIdx = -1;
  }

  /**
   * Get last measured GPU time in milliseconds
   */
  getLastTimeMs(): number {
    return this.lastTimeMs;
  }

  dispose(): void {
    this.disposed = true;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffers[0].destroy();
    this.readBuffers[1].destroy();
  }
}
