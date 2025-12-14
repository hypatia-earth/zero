/**
 * SlotService - GPU slot management for timestep data
 *
 * Manages GPU texture slots, creates TimestepOrders for QueueService,
 * and notifies TimestepService of GPU state changes.
 *
 * Replaces BudgetService's data loading with QueueService integration.
 */

import { effect, signal } from '@preact/signals-core';
import type { TParam, TTimestep, TimestepOrder } from '../config/types';
import type { ConfigService } from './config-service';
import type { StateService } from './state-service';
import type { TimestepService } from './timestep-service';
import type { RenderService } from './render-service';
import type { QueueService } from './queue-service';

const BYTES_PER_TIMESTEP = 6_599_680 * 4; // ~26.4 MB per param

export type LoadingStrategy = 'alternate' | 'future-first' | 'past-first';

export interface Slot {
  timestep: TTimestep;
  param: TParam;
  slotIndex: number;
  loaded: boolean;
  loadedPoints: number;
}

export class SlotService {
  private slots: Map<string, Slot> = new Map(); // key: `${param}:${timestep}`
  private maxSlots: number;
  private freeSlotIndices: number[] = [];
  private disposeEffect: (() => void) | null = null;
  private _strategy: LoadingStrategy = 'alternate';
  private loadingKeys: Set<string> = new Set();
  private initialized = false;

  // Active interpolation pair per param
  private activePair: Map<TParam, { t0: TTimestep; t1: TTimestep }> = new Map();

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  constructor(
    private configService: ConfigService,
    private stateService: StateService,
    private timestepService: TimestepService,
    private renderService: RenderService,
    private _queueService: QueueService
  ) {
    this.maxSlots = this.renderService.getRenderer().getMaxTempSlots();
    this.freeSlotIndices = Array.from({ length: this.maxSlots }, (_, i) => i);

    const requestedSlots = Math.floor(
      this.configService.getGpuBudgetMB() * 1024 * 1024 / BYTES_PER_TIMESTEP
    );
    console.log(`[Slot] Max slots: ${this.maxSlots} (requested ${requestedSlots})`);

    // Wire up lerp calculation
    this.renderService.setTempLerpFn((time) => this.getTempLerp(time));

    // React to time changes
    this.disposeEffect = effect(() => {
      const time = this.stateService.state.value.time;
      this.onTimeChange(time);
    });
  }

  /** Make slot key from param and timestep */
  private makeKey(param: TParam, timestep: TTimestep): string {
    return `${param}:${timestep}`;
  }

  /** Handle time change - determine what to load/evict */
  private onTimeChange(time: Date): void {
    if (!this.initialized) return;

    // Get adjacent timesteps
    const [t0, t1] = this.timestepService.adjacent(time);

    // Check for temp param (primary for now)
    const param: TParam = 'temp';
    const key0 = this.makeKey(param, t0);
    const key1 = this.makeKey(param, t1);

    const slot0 = this.slots.get(key0);
    const slot1 = this.slots.get(key1);

    if (slot0?.loaded && slot1?.loaded) {
      this.activePair.set(param, { t0, t1 });
      this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
      this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));
    }

    // TODO: Calculate load window, create orders, submit to QueueService
    // For now, just ensure current pair is loaded
    this.ensureLoaded(param, t0);
    this.ensureLoaded(param, t1);
  }

  /** Ensure a timestep is loaded or loading */
  private ensureLoaded(param: TParam, timestep: TTimestep): void {
    const key = this.makeKey(param, timestep);
    if (this.slots.has(key) || this.loadingKeys.has(key)) return;

    // Get free slot or evict
    const slotIndex = this.allocateSlot(param, timestep);
    if (slotIndex === null) return;

    this.loadingKeys.add(key);
    this.slots.set(key, {
      timestep,
      param,
      slotIndex,
      loaded: false,
      loadedPoints: 0,
    });

    // Create order and load via QueueService
    this.loadTimestep(param, timestep, slotIndex, key);
  }

  /** Allocate a slot index, evicting if necessary */
  private allocateSlot(_param: TParam, _timestep: TTimestep): number | null {
    if (this.freeSlotIndices.length > 0) {
      return this.freeSlotIndices.pop()!;
    }
    // TODO: Implement eviction based on distance from current time
    console.warn('[Slot] No free slots available');
    return null;
  }

  /** Load a timestep via QueueService */
  private async loadTimestep(
    param: TParam,
    timestep: TTimestep,
    slotIndex: number,
    key: string
  ): Promise<void> {
    try {
      const url = this.timestepService.url(timestep);
      const order: TimestepOrder = { url, param, timestep };

      console.log(`[Slot] Loading ${param}:${timestep} → slot ${slotIndex}`);

      await this._queueService.submitTimestepOrders(
        [order],
        (_order, slice) => {
          if (slice.done) {
            // Final slice - upload to GPU
            this.onDataReceived(param, timestep, slice.data);
          }
        }
      );

    } catch (err) {
      console.warn(`[Slot] Failed to load ${param}:${timestep}:`, err);
    } finally {
      this.loadingKeys.delete(key);
    }
  }

  /** Called when data arrives from QueueService */
  onDataReceived(param: TParam, timestep: TTimestep, data: Float32Array): void {
    const key = this.makeKey(param, timestep);
    const slot = this.slots.get(key);
    if (!slot) return;

    // Upload to GPU
    const renderer = this.renderService.getRenderer();
    renderer.uploadTempDataToSlot(data, slot.slotIndex);

    slot.loaded = true;
    slot.loadedPoints = data.length;

    // Notify TimestepService
    this.timestepService.setGpuLoaded(param, timestep);

    this.slotsVersion.value++;
    console.log(`[Slot] Loaded ${key} → slot ${slot.slotIndex}`);

    // Update shader if this completes the active pair
    this.updateShaderIfReady(param);
  }

  /** Update shader slots if both timesteps of active pair are loaded */
  private updateShaderIfReady(param: TParam): void {
    const time = this.stateService.getTime();
    const [t0, t1] = this.timestepService.adjacent(time);

    const slot0 = this.slots.get(this.makeKey(param, t0));
    const slot1 = this.slots.get(this.makeKey(param, t1));

    if (slot0?.loaded && slot1?.loaded) {
      this.activePair.set(param, { t0, t1 });
      if (param === 'temp') {
        this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
        this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));
      }
    }
  }

  /** Calculate lerp for shader interpolation */
  getTempLerp(currentTime: Date): number {
    const pair = this.activePair.get('temp');
    if (!pair) return -1;

    const t0 = this.timestepService.toDate(pair.t0).getTime();
    const t1 = this.timestepService.toDate(pair.t1).getTime();
    const tc = currentTime.getTime();

    if (tc < t0 || tc > t1) return -1;
    return (tc - t0) / (t1 - t0);
  }

  /** Initialize with first timestep pair */
  async initialize(): Promise<void> {
    const time = this.stateService.getTime();
    const [t0, t1] = this.timestepService.adjacent(time);
    const param: TParam = 'temp';

    console.log(`[Slot] Initializing with ${t0}, ${t1}`);

    // Allocate slots for initial pair
    const slot0 = this.freeSlotIndices.pop()!;
    const slot1 = this.freeSlotIndices.pop()!;
    const key0 = this.makeKey(param, t0);
    const key1 = this.makeKey(param, t1);

    this.slots.set(key0, { timestep: t0, param, slotIndex: slot0, loaded: false, loadedPoints: 0 });
    this.slots.set(key1, { timestep: t1, param, slotIndex: slot1, loaded: false, loadedPoints: 0 });
    this.loadingKeys.add(key0);
    this.loadingKeys.add(key1);

    // Load both timesteps
    await Promise.all([
      this.loadTimestep(param, t0, slot0, key0),
      this.loadTimestep(param, t1, slot1, key1),
    ]);

    // Set active pair and shader slots
    this.activePair.set(param, { t0, t1 });
    const s0 = this.slots.get(key0)!;
    const s1 = this.slots.get(key1)!;
    this.renderService.setTempSlots(s0.slotIndex, s1.slotIndex);
    this.renderService.setTempLoadedPoints(Math.min(s0.loadedPoints, s1.loadedPoints));

    this.initialized = true;
    this.slotsVersion.value++;
    console.log('[Slot] Initialized');
  }

  /** Get loaded timesteps for timebar */
  getLoadedTimestamps(param: TParam): TTimestep[] {
    const loaded: TTimestep[] = [];
    for (const slot of this.slots.values()) {
      if (slot.param === param && slot.loaded) {
        loaded.push(slot.timestep);
      }
    }
    return loaded.sort();
  }

  /** Get active pair for a param */
  getActivePair(param: TParam): { t0: TTimestep; t1: TTimestep } | null {
    return this.activePair.get(param) ?? null;
  }

  /** Set loading strategy */
  setStrategy(strategy: LoadingStrategy): void {
    this._strategy = strategy;
    console.log(`[Slot] Strategy: ${strategy}`);
  }

  /** Get QueueService (for future use) */
  getQueueService(): QueueService {
    return this._queueService;
  }

  /** Get current strategy */
  getStrategy(): LoadingStrategy {
    return this._strategy;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    this.slots.clear();
  }
}
