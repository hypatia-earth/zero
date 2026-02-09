/**
 * GPU timestamp query helper for render pass timing
 * Measures 3 passes: globe, geometry, post-process
 * Uses double-buffered read buffers to avoid mapAsync race conditions
 */

export interface PassTimings {
  pass1Ms: number;  // Globe pass
  pass2Ms: number;  // Geometry pass (pressure, wind)
  pass3Ms: number;  // Post-process (atmosphere)
}

export class GpuTimestamp {
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private readBuffers: [GPUBuffer, GPUBuffer];
  private pending: [boolean, boolean] = [false, false];
  private lastTimings: PassTimings = { pass1Ms: NaN, pass2Ms: NaN, pass3Ms: NaN };
  private disposed = false;
  private activeIdx: 0 | 1 | -1 = -1;

  constructor(device: GPUDevice) {
    // 6 timestamps: pass1 begin/end, pass2 begin/end, pass3 begin/end
    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: 6,
    });

    // 6 * 8 bytes = 48 bytes for BigUint64 timestamps
    this.resolveBuffer = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'timestamp-resolve',
    });

    this.readBuffers = [
      device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'timestamp-read-0' }),
      device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'timestamp-read-1' }),
    ];
  }

  static isSupported(adapter: GPUAdapter): boolean {
    return adapter.features.has('timestamp-query');
  }

  /** Timestamp writes for Pass 1 (globe) - indices 0,1 */
  getPass1TimestampWrites(): GPURenderPassTimestampWrites {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /** Timestamp writes for Pass 2 (geometry) - indices 2,3 */
  getPass2TimestampWrites(): GPURenderPassTimestampWrites {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 2,
      endOfPassWriteIndex: 3,
    };
  }

  /** Timestamp writes for Pass 3 (post-process) - indices 4,5 */
  getPass3TimestampWrites(): GPURenderPassTimestampWrites {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 4,
      endOfPassWriteIndex: 5,
    };
  }

  /** Encode resolve and copy commands. Call BEFORE queue.submit(). */
  encodeResolve(encoder: GPUCommandEncoder): void {
    if (this.disposed) return;

    const idx: 0 | 1 | -1 = !this.pending[0] ? 0 : !this.pending[1] ? 1 : -1;
    if (idx === -1) {
      this.activeIdx = -1;
      return;
    }

    this.activeIdx = idx;
    encoder.resolveQuerySet(this.querySet, 0, 6, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffers[idx], 0, 48);
  }

  /** Start async readback. Call AFTER queue.submit(). */
  startReadback(): void {
    if (this.disposed || this.activeIdx === -1) return;

    const idx = this.activeIdx;
    const readBuffer = this.readBuffers[idx];

    this.pending[idx] = true;
    readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const data = readBuffer.getMappedRange();
      const times = new BigUint64Array(data);

      // Calculate duration for each pass
      const nsToMs = (start: bigint, end: bigint) => {
        const ns = end > start ? Number(end - start) : Number(start - end);
        return ns / 1_000_000;
      };

      this.lastTimings = {
        pass1Ms: nsToMs(times[0]!, times[1]!),
        pass2Ms: nsToMs(times[2]!, times[3]!),
        pass3Ms: nsToMs(times[4]!, times[5]!),
      };

      readBuffer.unmap();
      this.pending[idx] = false;
    }).catch(() => {
      this.pending[idx] = false;
    });

    this.activeIdx = -1;
  }

  /** Get last measured GPU times for all passes */
  getLastTimings(): PassTimings {
    return this.lastTimings;
  }

  /** Get last measured total GPU time (sum of all passes) */
  getLastTimeMs(): number {
    const t = this.lastTimings;
    if (isNaN(t.pass1Ms)) return NaN;
    return t.pass1Ms + (isNaN(t.pass2Ms) ? 0 : t.pass2Ms) + t.pass3Ms;
  }

  dispose(): void {
    this.disposed = true;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffers[0].destroy();
    this.readBuffers[1].destroy();
  }
}
