/**
 * LayerStore - Per-layer GPU buffer management
 *
 * Each weather layer gets its own LayerStore instance.
 * Manages: GPUBuffer allocation, timeslot tracking, resize operations.
 * SlotService orchestrates multiple LayerStore instances.
 */

import type { TTimestep, SlabConfig } from '../config/types';

export interface LayerStoreConfig {
  layerId: string;
  slabs: SlabConfig[];
  maxTimeslots: number;
}

/** Handle to an allocated timeslot within the store */
export interface TimeslotHandle {
  timestep: TTimestep;
  slotIndex: number;
  slabOffsets: number[];  // byte offset per slab within respective GPUBuffer
}

export class LayerStore {
  readonly layerId: string;
  readonly slabs: SlabConfig[];
  readonly timeslotSizeMB: number;

  private maxTimeslots: number;
  private timeslots = new Map<TTimestep, TimeslotHandle>();
  private gpuBuffers: GPUBuffer[] = [];
  private freeSlotIndices: number[] = [];

  constructor(
    private device: GPUDevice,
    config: LayerStoreConfig,
  ) {
    this.layerId = config.layerId;
    this.slabs = config.slabs;
    this.maxTimeslots = config.maxTimeslots;
    this.timeslotSizeMB = this.slabs.reduce((sum, s) => sum + s.sizeMB, 0);
  }

  /** Initialize GPU buffers - call after construction */
  initialize(): void {
    // Create one buffer per slab type, sized for maxTimeslots
    for (const slab of this.slabs) {
      const buffer = this.device.createBuffer({
        size: slab.sizeMB * 1024 * 1024 * this.maxTimeslots,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `${this.layerId}-${slab.name}`,
      });
      this.gpuBuffers.push(buffer);
    }

    // Initialize free slot indices
    this.freeSlotIndices = Array.from({ length: this.maxTimeslots }, (_, i) => i);
  }

  /** Allocate a timeslot for the given timestep */
  allocateTimeslot(timestep: TTimestep): TimeslotHandle | null {
    // Already allocated?
    const existing = this.timeslots.get(timestep);
    if (existing) return existing;

    // Need free slot
    if (this.freeSlotIndices.length === 0) {
      return null;  // Caller must evict first
    }

    const slotIndex = this.freeSlotIndices.pop()!;

    // Calculate byte offsets for each slab buffer
    const slabOffsets = this.slabs.map(slab =>
      slotIndex * slab.sizeMB * 1024 * 1024
    );

    const handle: TimeslotHandle = { timestep, slotIndex, slabOffsets };
    this.timeslots.set(timestep, handle);
    return handle;
  }

  /** Free a timeslot */
  disposeTimeslot(timestep: TTimestep): void {
    const handle = this.timeslots.get(timestep);
    if (!handle) return;

    this.freeSlotIndices.push(handle.slotIndex);
    this.timeslots.delete(timestep);
  }

  /** Get handle for an existing timeslot */
  getTimeslot(timestep: TTimestep): TimeslotHandle | undefined {
    return this.timeslots.get(timestep);
  }

  /** Check if timestep has an allocated timeslot */
  hasTimeslot(timestep: TTimestep): boolean {
    return this.timeslots.has(timestep);
  }

  /** Get all GPUBuffers (one per slab type) */
  getBuffers(): GPUBuffer[] {
    return this.gpuBuffers;
  }

  /** Get current capacity */
  getMaxTimeslots(): number {
    return this.maxTimeslots;
  }

  /** Get number of allocated timeslots */
  getAllocatedCount(): number {
    return this.timeslots.size;
  }

  /** Find furthest timeslot from reference time for eviction */
  findEvictionCandidate(
    referenceTime: Date,
    toDate: (ts: TTimestep) => Date,
  ): TTimestep | null {
    let furthest: TTimestep | null = null;
    let maxDistance = -1;

    for (const [ts] of this.timeslots) {
      const distance = Math.abs(toDate(ts).getTime() - referenceTime.getTime());
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = ts;
      }
    }

    return furthest;
  }

  /** Write data to a specific slab at slot index */
  writeToSlab(slabIndex: number, slotIndex: number, data: Float32Array<ArrayBuffer>): void {
    const slab = this.slabs[slabIndex];
    if (!slab) throw new Error(`Invalid slab index: ${slabIndex}`);

    const buffer = this.gpuBuffers[slabIndex];
    if (!buffer) throw new Error(`No buffer for slab: ${slab.name}`);

    const byteOffset = slotIndex * slab.sizeMB * 1024 * 1024;
    this.device.queue.writeBuffer(buffer, byteOffset, data);
  }

  /** Get slab index by name */
  getSlabIndex(slabName: string): number {
    const index = this.slabs.findIndex(s => s.name === slabName);
    if (index === -1) throw new Error(`Unknown slab: ${slabName}`);
    return index;
  }

  /**
   * Resize store capacity - may grow or shrink.
   * Note: This destroys existing buffers and clears timeslots.
   * Data will need to be refetched after resize.
   * @throws Error if buffer creation fails (OOM)
   */
  resize(newMaxTimeslots: number): void {
    if (newMaxTimeslots === this.maxTimeslots) return;

    const oldMax = this.maxTimeslots;
    const evictedTimesteps = [...this.timeslots.keys()];

    // Destroy old buffers
    for (const buffer of this.gpuBuffers) {
      buffer.destroy();
    }
    this.gpuBuffers = [];
    this.timeslots.clear();

    // Update capacity
    this.maxTimeslots = newMaxTimeslots;

    // Create new buffers (may throw OOM)
    for (const slab of this.slabs) {
      const buffer = this.device.createBuffer({
        size: slab.sizeMB * 1024 * 1024 * this.maxTimeslots,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `${this.layerId}-${slab.name}`,
      });
      this.gpuBuffers.push(buffer);
    }

    // Reset free indices
    this.freeSlotIndices = Array.from({ length: this.maxTimeslots }, (_, i) => i);

    console.log(`[Store] ${this.layerId} resized: ${oldMax} → ${newMaxTimeslots} timeslots (${evictedTimesteps.length} evicted)`);
  }

  /** Clean up GPU resources */
  dispose(): void {
    for (const buffer of this.gpuBuffers) {
      buffer.destroy();
    }
    this.gpuBuffers = [];
    this.timeslots.clear();
    this.freeSlotIndices = [];
  }
}
