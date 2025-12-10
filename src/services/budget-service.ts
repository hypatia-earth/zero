/**
 * BudgetService - GPU memory budget management for timestep data
 *
 * Manages a "Load Window" of timesteps in GPU memory, sliding within
 * the fixed Data Window as user moves the time knob.
 *
 * Key concepts:
 * - Data Window: Fixed at startup (±dataWindowDays from today)
 * - Load Window: Dynamic subset of timesteps in GPU (budget-limited)
 * - Slot: One timestep's worth of GPU memory (~26.4 MB per param)
 */

import { effect } from '@preact/signals-core';
import type { ConfigService } from './config-service';
import type { StateService } from './state-service';
import { DataService, type ProgressUpdate } from './data-service';
import type { RenderService } from './render-service';
import { BootstrapService } from './bootstrap-service';

const BYTES_PER_TIMESTEP = 6_599_680 * 4; // 6.6M floats × 4 bytes = ~26.4 MB

export type LoadingStrategy = 'alternate' | 'future-first' | 'past-first';

export interface TimestepSlot {
  timestamp: Date;
  slotIndex: number;
  loaded: boolean;
  loadedPoints: number;
}

export class BudgetService {
  private slots: Map<string, TimestepSlot> = new Map();
  private maxSlots: number;
  private freeSlotIndices: number[] = [];  // Available GPU buffer positions
  private disposeEffect: (() => void) | null = null;
  private dataWindowStart: Date;
  private dataWindowEnd: Date;
  private strategy: LoadingStrategy = 'alternate';
  private loadingTimestamps: Set<string> = new Set();  // Prevent duplicate loads
  private initialized = false;
  private activeT0: Date | null = null;  // Currently active timestep pair
  private activeT1: Date | null = null;

  constructor(
    private configService: ConfigService,
    private stateService: StateService,
    private dataService: DataService,
    private renderService: RenderService
  ) {
    const budgetBytes = this.configService.getGpuBudgetMB() * 1024 * 1024;
    this.maxSlots = Math.floor(budgetBytes / BYTES_PER_TIMESTEP);

    // Initialize free slot indices (all available at start)
    this.freeSlotIndices = Array.from({ length: this.maxSlots }, (_, i) => i);

    // Calculate fixed data window at startup
    const window = this.dataService.getDataWindow();
    this.dataWindowStart = window.start;
    this.dataWindowEnd = window.end;

    console.log(`[Budget] Max slots: ${this.maxSlots} (${this.configService.getGpuBudgetMB()} MB budget)`);
    console.log(`[Budget] Data window: ${this.dataWindowStart.toISOString()} - ${this.dataWindowEnd.toISOString()}`);

    // Wire up lerp calculation
    this.renderService.setTempLerpFn((time) => this.getTempLerp(time));

    // React to time changes
    this.disposeEffect = effect(() => {
      const time = this.stateService.state.value.time;
      this.onTimeChange(time);
    });
  }

  private onTimeChange(time: Date): void {
    // Skip if not yet initialized (initial load handles first timesteps)
    if (!this.initialized) return;

    // Get adjacent timesteps for current time
    const [t0, t1] = this.dataService.getAdjacentTimestamps(time);
    const t0Key = t0.toISOString();
    const t1Key = t1.toISOString();

    // Check if we have the required timesteps loaded
    const slot0 = this.slots.get(t0Key);
    const slot1 = this.slots.get(t1Key);

    if (slot0?.loaded && slot1?.loaded) {
      // Both loaded - update shader and active pair
      this.activeT0 = t0;
      this.activeT1 = t1;
      this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
      this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));
      // Don't return - continue to rebalance window
    }

    // Calculate ideal window and diff
    const idealWindow = this.calculateLoadWindow(time);
    const current = new Set(this.slots.keys());
    const ideal = new Set(idealWindow.map(t => t.toISOString()));

    const toEvict = [...current].filter(k => !ideal.has(k));
    const toLoad = idealWindow.filter(t => !current.has(t.toISOString()));

    if (toEvict.length > 0 || toLoad.length > 0) {
      console.log(`[Budget] Time ${time.toISOString()}: evict ${toEvict.length}, load ${toLoad.length}`);
    }

    // Evict old slots - return their indices to the free pool
    for (const key of toEvict) {
      const slot = this.slots.get(key);
      if (slot) {
        this.freeSlotIndices.push(slot.slotIndex);
        this.slots.delete(key);
      }
    }

    // Prioritize loading t0 and t1 for current time first
    const priorityTimestamps = [t0, t1].filter(t => !this.slots.has(t.toISOString()));
    const otherTimestamps = toLoad.filter(t =>
      t.toISOString() !== t0Key && t.toISOString() !== t1Key
    );
    const orderedToLoad = [...priorityTimestamps, ...otherTimestamps];

    // Queue new timesteps for loading (one at a time to avoid WASM OOM)
    for (const timestamp of orderedToLoad) {
      const key = timestamp.toISOString();
      if (this.loadingTimestamps.has(key)) continue;  // Already loading
      if (this.slots.has(key)) continue;  // Already have this slot

      // Only allow one concurrent load to avoid WASM OOM
      if (this.loadingTimestamps.size > 0) break;

      // Get a free slot index
      if (this.freeSlotIndices.length === 0) break;  // Budget full
      const newSlotIndex = this.freeSlotIndices.pop()!;

      this.slots.set(key, {
        timestamp,
        slotIndex: newSlotIndex,
        loaded: false,
        loadedPoints: 0,
      });

      // Load in background
      this.loadTimestepToSlot(timestamp, newSlotIndex);
    }
  }

  /**
   * Load a single timestep to a specific slot
   */
  private async loadTimestepToSlot(timestamp: Date, slotIndex: number): Promise<void> {
    const key = timestamp.toISOString();
    if (this.loadingTimestamps.has(key)) return;
    this.loadingTimestamps.add(key);

    try {
      const data = await this.dataService.loadSingleTimestep(timestamp);

      // Upload to GPU slot
      const renderer = this.renderService.getRenderer();
      await renderer.uploadTempDataToSlot(data, slotIndex);

      // Update slot metadata
      const slot = this.slots.get(key);
      if (slot) {
        slot.loaded = true;
        slot.loadedPoints = data.length;
        console.log(`[Budget] Loaded ${key} → slot ${slotIndex}`);
      }

      // Check if we now have the pair for current time
      this.updateShaderSlotsIfReady();

    } catch (err) {
      console.warn(`[Budget] Failed to load ${key}:`, err);
    } finally {
      this.loadingTimestamps.delete(key);

      // Trigger loading next timestep (re-evaluate current time)
      const currentTime = this.stateService.getTime();
      this.onTimeChange(currentTime);
    }
  }

  /**
   * Update shader slots if both required timesteps are loaded
   */
  private updateShaderSlotsIfReady(): void {
    const time = this.stateService.getTime();
    const [t0, t1] = this.dataService.getAdjacentTimestamps(time);

    const slot0 = this.slots.get(t0.toISOString());
    const slot1 = this.slots.get(t1.toISOString());

    if (slot0?.loaded && slot1?.loaded) {
      this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
      this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));

      // Track active pair for lerp calculation
      this.activeT0 = t0;
      this.activeT1 = t1;
    }
  }

  /**
   * Calculate interpolation factor for current time between active timesteps
   * Returns -1 if current time is outside active pair (signals: don't render)
   */
  getTempLerp(currentTime: Date): number {
    if (!this.activeT0 || !this.activeT1) {
      return -1;  // No data loaded
    }
    const t0 = this.activeT0.getTime();
    const t1 = this.activeT1.getTime();
    const tc = currentTime.getTime();

    // Check if current time is within the active pair
    if (tc < t0 || tc > t1) {
      return -1;  // Outside active pair - don't render stale data
    }

    return (tc - t0) / (t1 - t0);
  }

  /**
   * Get the active timestep pair
   */
  getActiveTimesteps(): { t0: Date | null; t1: Date | null } {
    return { t0: this.activeT0, t1: this.activeT1 };
  }

  /**
   * Calculate ideal load window around the given time
   * Uses the configured loading strategy (alternate, future-first, past-first)
   */
  calculateLoadWindow(knobTime: Date): Date[] {
    const latestRun = this.dataService.getLatestRun();
    if (!latestRun) return [];

    const [t0, t1] = this.dataService.getAdjacentTimestamps(knobTime);
    const slots: Date[] = [t0, t1];

    let pastCursor = this.getPreviousTimestep(t0, latestRun);
    let futureCursor = this.getNextTimestep(t1, latestRun);

    while (slots.length < this.maxSlots) {
      const addedAny = this.addNextSlot(slots, pastCursor, futureCursor, latestRun);
      if (!addedAny) break;

      // Update cursors after adding
      if (slots.includes(futureCursor!)) {
        futureCursor = this.getNextTimestep(futureCursor!, latestRun);
      }
      if (slots.includes(pastCursor!)) {
        pastCursor = this.getPreviousTimestep(pastCursor!, latestRun);
      }
    }

    return slots;
  }

  /**
   * Add next slot based on strategy
   * Returns true if a slot was added
   */
  private addNextSlot(
    slots: Date[],
    pastCursor: Date | null,
    futureCursor: Date | null,
    _latestRun: Date  // Reserved for future resolution-aware logic
  ): boolean {
    const canAddFuture = futureCursor && futureCursor <= this.dataWindowEnd;
    const canAddPast = pastCursor && pastCursor >= this.dataWindowStart;

    switch (this.strategy) {
      case 'future-first':
        if (canAddFuture) {
          slots.push(futureCursor!);
          return true;
        }
        if (canAddPast) {
          slots.push(pastCursor!);
          return true;
        }
        return false;

      case 'past-first':
        if (canAddPast) {
          slots.push(pastCursor!);
          return true;
        }
        if (canAddFuture) {
          slots.push(futureCursor!);
          return true;
        }
        return false;

      case 'alternate':
      default:
        // Alternate: future, past, future, past...
        // Check which direction has more slots already
        const futureCount = slots.filter(s => s > slots[0]!).length;
        const pastCount = slots.filter(s => s < slots[0]!).length;

        if (futureCount <= pastCount && canAddFuture) {
          slots.push(futureCursor!);
          return true;
        }
        if (canAddPast) {
          slots.push(pastCursor!);
          return true;
        }
        if (canAddFuture) {
          slots.push(futureCursor!);
          return true;
        }
        return false;
    }
  }

  /**
   * Get the previous timestep (respecting variable resolution)
   */
  private getPreviousTimestep(time: Date, latestRun: Date): Date | null {
    const resolution = this.getTimestepResolution(time, latestRun);
    const prev = new Date(time);
    prev.setUTCHours(prev.getUTCHours() - resolution);
    return prev >= this.dataWindowStart ? prev : null;
  }

  /**
   * Get the next timestep (respecting variable resolution)
   */
  private getNextTimestep(time: Date, latestRun: Date): Date | null {
    const resolution = this.getTimestepResolution(time, latestRun);
    const next = new Date(time);
    next.setUTCHours(next.getUTCHours() + resolution);
    return next <= this.dataWindowEnd ? next : null;
  }

  /**
   * Get timestep resolution based on offset from latest run
   * - 0-90h: 1h resolution
   * - 90-144h: 3h resolution
   * - 144h+: 6h resolution
   */
  private getTimestepResolution(time: Date, latestRun: Date): number {
    const offsetHours = (time.getTime() - latestRun.getTime()) / (1000 * 60 * 60);
    if (offsetHours <= 90) return 1;
    if (offsetHours <= 144) return 3;
    return 6;
  }

  /**
   * Check if a timestep is loaded in GPU
   */
  hasTimestep(timestamp: Date): boolean {
    const slot = this.slots.get(timestamp.toISOString());
    return slot?.loaded ?? false;
  }

  /**
   * Check if a timestep is in the load window (may not be loaded yet)
   */
  hasSlot(timestamp: Date): boolean {
    return this.slots.has(timestamp.toISOString());
  }

  /**
   * Get current slot count
   */
  getSlotCount(): number {
    return this.slots.size;
  }

  /**
   * Get max slot count (budget-derived)
   */
  getMaxSlots(): number {
    return this.maxSlots;
  }

  /**
   * Get all timestamps in the load window (for UI visualization)
   */
  getLoadedTimestamps(): Date[] {
    return Array.from(this.slots.values()).map(s => s.timestamp);
  }

  /**
   * Get the data window boundaries
   */
  getDataWindow(): { start: Date; end: Date } {
    return { start: this.dataWindowStart, end: this.dataWindowEnd };
  }

  /**
   * Set loading strategy
   */
  setStrategy(strategy: LoadingStrategy): void {
    this.strategy = strategy;
    console.log(`[Budget] Strategy set to: ${strategy}`);
  }

  /**
   * Get the render service (for buffer management)
   */
  getRenderService(): RenderService {
    return this.renderService;
  }

  /**
   * Initialize data service and load initial timesteps for current time
   * Called during bootstrap - loads t0 and t1 for immediate interpolation
   */
  async loadInitialTimesteps(): Promise<void> {
    try {
      // Initialize data service (find latest available run from S3)
      await this.dataService.initialize();

      const currentTime = this.stateService.getTime();
      const [t0, t1] = this.dataService.getAdjacentTimestamps(currentTime);

      // Allocate slots for t0 and t1 from free pool
      const slot0Index = this.freeSlotIndices.pop()!;
      const slot1Index = this.freeSlotIndices.pop()!;

      this.slots.set(t0.toISOString(), {
        timestamp: t0,
        slotIndex: slot0Index,
        loaded: false,
        loadedPoints: 0,
      });
      this.slots.set(t1.toISOString(), {
        timestamp: t1,
        slotIndex: slot1Index,
        loaded: false,
        loadedPoints: 0,
      });

      console.log(`[Budget] Loading initial timesteps: ${t0.toISOString()} → slot ${slot0Index}, ${t1.toISOString()} → slot ${slot1Index}`);

      // Set active pair immediately so shader can render progressive data
      this.activeT0 = t0;
      this.activeT1 = t1;
      this.renderService.setTempSlots(slot0Index, slot1Index);

      // Progressive loading with chunk callbacks
      await this.dataService.loadProgressiveInterleaved(
        currentTime,
        async (update: ProgressUpdate) => {
          // Upload to the allocated slots
          const renderer = this.renderService.getRenderer();
          await renderer.uploadTempDataToSlot(update.data0, slot0Index);
          await renderer.uploadTempDataToSlot(update.data1, slot1Index);
          this.renderService.setTempLoadedPoints(update.data0.length);

          // Update slot metadata
          const slot0 = this.slots.get(t0.toISOString());
          const slot1 = this.slots.get(t1.toISOString());
          if (slot0) {
            slot0.loadedPoints = update.data0.length;
            slot0.loaded = update.done;
          }
          if (slot1) {
            slot1.loadedPoints = update.data1.length;
            slot1.loaded = update.done;
          }

          // Update bootstrap progress (55-95% range)
          const progress = 55 + (update.sliceIndex / update.totalSlices) * 40;
          BootstrapService.setProgress(progress);

          console.log(`[Budget] Uploaded slice ${update.sliceIndex}/${update.totalSlices} to GPU${update.done ? ' - DONE' : ''}`);
        }
      );

      // Mark as initialized - now time changes will trigger loading
      this.initialized = true;

      console.log('[Budget] Initial timesteps loaded, budget service active');
    } catch (err) {
      console.warn('[Budget] Failed to load initial timesteps:', err);
    }
  }

  dispose(): void {
    if (this.disposeEffect) {
      this.disposeEffect();
      this.disposeEffect = null;
    }
    this.slots.clear();
  }
}
