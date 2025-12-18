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
  timeslots: number;
  /**
   * Per-slot buffer mode: each timeslot gets its own GPUBuffer.
   * Enables rebinding for unlimited slots (limited only by VRAM).
   * When false (default): one large buffer with offsets (201MB binding limit).
   */
  usePerSlotBuffers?: boolean;
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
  readonly usePerSlotBuffers: boolean;

  private timeslotCount: number;
  private timeslots = new Map<TTimestep, TimeslotHandle>();
  private gpuBuffers: GPUBuffer[] = [];  // Legacy: one buffer per slab (all slots)
  private slotBuffers = new Map<number, GPUBuffer[]>();  // Per-slot: slotIndex -> buffer per slab
  private freeSlotIndices: number[] = [];

  constructor(
    private device: GPUDevice,
    config: LayerStoreConfig,
  ) {
    this.layerId = config.layerId;
    this.slabs = config.slabs;
    this.timeslotCount = config.timeslots;
    this.usePerSlotBuffers = config.usePerSlotBuffers ?? false;
    this.timeslotSizeMB = this.slabs.reduce((sum, s) => sum + s.sizeMB, 0);
  }

  /** Initialize GPU buffers - call after construction */
  initialize(): void {
    if (this.usePerSlotBuffers) {
      // Per-slot mode: buffers created on demand in allocateTimeslot()
      // No upfront allocation - unlimited slots (limited by VRAM only)
      console.log(`[Store] ${this.layerId} initialized (per-slot mode, max ${this.timeslotCount})`);
    } else {
      // Legacy mode: create one buffer per slab type, sized for maxTimeslots
      for (const slab of this.slabs) {
        const buffer = this.device.createBuffer({
          size: slab.sizeMB * 1024 * 1024 * this.timeslotCount,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: `${this.layerId}-${slab.name}`,
        });
        this.gpuBuffers.push(buffer);
      }
    }

    // Initialize free slot indices
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

    // Per-slot mode: create buffers for this slot
    if (this.usePerSlotBuffers) {
      const buffers = this.slabs.map(slab =>
        this.device.createBuffer({
          size: slab.sizeMB * 1024 * 1024,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: `${this.layerId}-${slab.name}-slot${slotIndex}`,
        })
      );
      this.slotBuffers.set(slotIndex, buffers);
    }

    // Calculate byte offsets (legacy mode uses offsets, per-slot is always 0)
    const slabOffsets = this.usePerSlotBuffers
      ? this.slabs.map(() => 0)
      : this.slabs.map(slab => slotIndex * slab.sizeMB * 1024 * 1024);

    const handle: TimeslotHandle = { timestep, slotIndex, slabOffsets };
    this.timeslots.set(timestep, handle);
    return handle;
  }

  /** Free a timeslot */
  disposeTimeslot(timestep: TTimestep): void {
    const handle = this.timeslots.get(timestep);
    if (!handle) return;

    // Per-slot mode: destroy this slot's buffers
    if (this.usePerSlotBuffers) {
      const buffers = this.slotBuffers.get(handle.slotIndex);
      if (buffers) {
        for (const buffer of buffers) {
          buffer.destroy();
        }
        this.slotBuffers.delete(handle.slotIndex);
      }
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

  /** Get all GPUBuffers (one per slab type) - legacy mode only */
  getBuffers(): GPUBuffer[] {
    return this.gpuBuffers;
  }

  /** Get buffer for a specific slot (per-slot mode) */
  getSlotBuffer(slotIndex: number, slabIndex: number): GPUBuffer | undefined {
    return this.slotBuffers.get(slotIndex)?.[slabIndex];
  }

  /** Ensure buffers exist for a slot (per-slot mode only, creates if missing) */
  ensureSlotBuffers(slotIndex: number): void {
    if (!this.usePerSlotBuffers) return;
    if (this.slotBuffers.has(slotIndex)) return;  // Already exists

    const buffers = this.slabs.map(slab =>
      this.device.createBuffer({
        size: slab.sizeMB * 1024 * 1024,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `${this.layerId}-${slab.name}-slot${slotIndex}`,
      })
    );
    this.slotBuffers.set(slotIndex, buffers);
  }

  /** Destroy buffers for a slot (per-slot mode only) */
  destroySlotBuffers(slotIndex: number): void {
    if (!this.usePerSlotBuffers) return;
    const buffers = this.slotBuffers.get(slotIndex);
    if (buffers) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      this.slotBuffers.delete(slotIndex);
    }
  }

  /** Get current capacity */
  getMaxTimeslots(): number {
    return this.timeslotCount;
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
  writeToSlab(slabIndex: number, slotIndex: number, data: Float32Array): void {
    const slab = this.slabs[slabIndex];
    if (!slab) throw new Error(`Invalid slab index: ${slabIndex}`);

    if (this.usePerSlotBuffers) {
      // Per-slot mode: write at offset 0 to slot's buffer
      const buffer = this.slotBuffers.get(slotIndex)?.[slabIndex];
      if (!buffer) throw new Error(`No buffer for slot ${slotIndex} slab ${slab.name}`);
      this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    } else {
      // Legacy mode: write at offset within large buffer
      const buffer = this.gpuBuffers[slabIndex];
      if (!buffer) throw new Error(`No buffer for slab: ${slab.name}`);
      const byteOffset = slotIndex * slab.sizeMB * 1024 * 1024;
      this.device.queue.writeBuffer(buffer, byteOffset, data.buffer, data.byteOffset, data.byteLength);
    }
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
    if (newMaxTimeslots === this.timeslotCount) return;

    const oldMax = this.timeslotCount;
    const evictedTimesteps = [...this.timeslots.keys()];

    if (this.usePerSlotBuffers) {
      // Per-slot mode: destroy all slot buffers
      for (const buffers of this.slotBuffers.values()) {
        for (const buffer of buffers) {
          buffer.destroy();
        }
      }
      this.slotBuffers.clear();
    } else {
      // Legacy mode: destroy slab buffers
      for (const buffer of this.gpuBuffers) {
        buffer.destroy();
      }
      this.gpuBuffers = [];

      // Create new buffers (may throw OOM)
      for (const slab of this.slabs) {
        const buffer = this.device.createBuffer({
          size: slab.sizeMB * 1024 * 1024 * newMaxTimeslots,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: `${this.layerId}-${slab.name}`,
        });
        this.gpuBuffers.push(buffer);
      }
    }

    this.timeslots.clear();
    this.timeslotCount = newMaxTimeslots;
    this.freeSlotIndices = Array.from({ length: this.timeslotCount }, (_, i) => i);

    console.log(`[Store] ${this.layerId} resized: ${oldMax} → ${newMaxTimeslots} timeslots (${evictedTimesteps.length} evicted)`);
  }

  /** Clean up GPU resources */
  dispose(): void {
    // Legacy mode buffers
    for (const buffer of this.gpuBuffers) {
      buffer.destroy();
    }
    this.gpuBuffers = [];

    // Per-slot mode buffers
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
