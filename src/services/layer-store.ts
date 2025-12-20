/**
 * LayerStore - Per-layer GPU buffer management
 *
 * Each weather layer gets its own LayerStore instance.
 * Manages: GPUBuffer allocation, timeslot tracking, resize operations.
 * SlotService orchestrates multiple LayerStore instances.
 *
 * Architecture: Per-slot buffers (each timeslot gets its own GPUBuffer)
 * - Enables rebinding for unlimited slots (limited only by VRAM)
 * - No 201MB binding size limit
 */

import type { TTimestep, SlabConfig } from '../config/types';

export interface LayerStoreConfig {
  layerId: string;
  slabs: SlabConfig[];
  timeslots: number;
}

/** Handle to an allocated timeslot within the store */
export interface TimeslotHandle {
  timestep: TTimestep;
  slotIndex: number;
}

export class LayerStore {
  readonly layerId: string;
  readonly slabs: SlabConfig[];
  readonly timeslotSizeMB: number;

  private timeslotCount: number;
  private timeslots = new Map<TTimestep, TimeslotHandle>();
  private slotBuffers = new Map<number, GPUBuffer[]>();  // slotIndex -> buffer per slab
  private freeSlotIndices: number[] = [];

  constructor(
    private device: GPUDevice,
    config: LayerStoreConfig,
  ) {
    this.layerId = config.layerId;
    this.slabs = config.slabs;
    this.timeslotCount = config.timeslots;
    this.timeslotSizeMB = this.slabs.reduce((sum, s) => sum + s.sizeMB, 0);
  }

  /** Initialize - call after construction */
  initialize(): void {
    // Per-slot mode: buffers created on demand in allocateTimeslot()
    this.freeSlotIndices = Array.from({ length: this.timeslotCount }, (_, i) => i);
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

    // Create buffers for this slot
    const buffers = this.slabs.map(slab =>
      this.device.createBuffer({
        size: slab.sizeMB * 1024 * 1024,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `${this.layerId}-${slab.name}-slot${slotIndex}`,
      })
    );
    this.slotBuffers.set(slotIndex, buffers);

    const handle: TimeslotHandle = { timestep, slotIndex };
    this.timeslots.set(timestep, handle);
    return handle;
  }

  /** Free a timeslot */
  disposeTimeslot(timestep: TTimestep): void {
    const handle = this.timeslots.get(timestep);
    if (!handle) return;

    // Destroy this slot's buffers
    const buffers = this.slotBuffers.get(handle.slotIndex);
    if (buffers) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      this.slotBuffers.delete(handle.slotIndex);
    }

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

  /** Get buffer for a specific slot */
  getSlotBuffer(slotIndex: number, slabIndex: number): GPUBuffer | undefined {
    return this.slotBuffers.get(slotIndex)?.[slabIndex];
  }

  /** Ensure buffers exist for a slot (creates if missing) */
  ensureSlotBuffers(slotIndex: number): void {
    if (this.slotBuffers.has(slotIndex)) return;

    const buffers = this.slabs.map(slab =>
      this.device.createBuffer({
        size: slab.sizeMB * 1024 * 1024,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `${this.layerId}-${slab.name}-slot${slotIndex}`,
      })
    );
    this.slotBuffers.set(slotIndex, buffers);
  }

  /** Destroy buffers for a slot */
  destroySlotBuffers(slotIndex: number): void {
    const buffers = this.slotBuffers.get(slotIndex);
    if (buffers) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      this.slotBuffers.delete(slotIndex);
    }
  }

  /** Get current capacity */
  getTimeslotCount(): number {
    return this.timeslotCount;
  }

  /** Get number of allocated slot buffers */
  getAllocatedCount(): number {
    return this.slotBuffers.size;
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
  writeToSlab(slabIndex: number, slotIndex: number, data: Float32Array): void {
    const slab = this.slabs[slabIndex];
    if (!slab) throw new Error(`Invalid slab index: ${slabIndex}`);

    const buffer = this.slotBuffers.get(slotIndex)?.[slabIndex];
    if (!buffer) throw new Error(`No buffer for slot ${slotIndex} slab ${slab.name}`);
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  /** Get slab index by name */
  getSlabIndex(slabName: string): number {
    const index = this.slabs.findIndex(s => s.name === slabName);
    if (index === -1) throw new Error(`Unknown slab: ${slabName}`);
    return index;
  }

  /**
   * Resize store capacity - may grow or shrink.
   * Growing: preserves existing buffers, adds new free indices.
   * Shrinking: destroys all buffers (data refetch needed).
   */
  resize(newTimeslots: number): void {
    if (newTimeslots === this.timeslotCount) return;

    const oldCount = this.timeslotCount;

    if (newTimeslots > oldCount) {
      // Growing: preserve existing buffers, add new free indices
      for (let i = oldCount; i < newTimeslots; i++) {
        this.freeSlotIndices.push(i);
      }
      this.timeslotCount = newTimeslots;
      console.log(`[Store] ${this.layerId} grew: ${oldCount} → ${newTimeslots} slots (${this.slotBuffers.size} preserved)`);
    } else {
      // Shrinking: destroy all buffers (TODO: preserve closest to current time)
      const evictedCount = this.slotBuffers.size;
      for (const buffers of this.slotBuffers.values()) {
        for (const buffer of buffers) {
          buffer.destroy();
        }
      }
      this.slotBuffers.clear();
      this.timeslots.clear();
      this.timeslotCount = newTimeslots;
      this.freeSlotIndices = Array.from({ length: this.timeslotCount }, (_, i) => i);
      console.log(`[Store] ${this.layerId} shrunk: ${oldCount} → ${newTimeslots} slots (${evictedCount} evicted)`);
    }
  }

  /** Clean up GPU resources */
  dispose(): void {
    for (const buffers of this.slotBuffers.values()) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
    }
    this.slotBuffers.clear();
    this.timeslots.clear();
    this.freeSlotIndices = [];
  }
}
