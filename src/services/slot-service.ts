/**
 * SlotService - GPU slot management for timestep data
 *
 * Manages GPU texture slots, loads data via QueueService → OmService,
 * and handles load window calculation with eviction.
 *
 * Replaces BudgetService.
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
  private strategy: LoadingStrategy = 'alternate';
  private loadingKeys: Set<string> = new Set();
  private initialized = false;

  // Data window boundaries
  private dataWindowStart!: TTimestep;
  private dataWindowEnd!: TTimestep;

  // Active interpolation pair per param
  private activePair: Map<TParam, { t0: TTimestep; t1: TTimestep }> = new Map();

  /** Signal for UI reactivity */
  readonly slotsVersion = signal(0);

  constructor(
    private configService: ConfigService,
    private stateService: StateService,
    private timestepService: TimestepService,
    private renderService: RenderService,
    private queueService: QueueService
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

  /** Handle time change - load/evict as needed */
  private onTimeChange(time: Date): void {
    if (!this.initialized) return;

    const param: TParam = 'temp';
    const [t0, t1] = this.timestepService.adjacent(time);
    const key0 = this.makeKey(param, t0);
    const key1 = this.makeKey(param, t1);

    // Update shader if both loaded
    const slot0 = this.slots.get(key0);
    const slot1 = this.slots.get(key1);

    if (slot0?.loaded && slot1?.loaded) {
      this.activePair.set(param, { t0, t1 });
      this.renderService.setTempSlots(slot0.slotIndex, slot1.slotIndex);
      this.renderService.setTempLoadedPoints(Math.min(slot0.loadedPoints, slot1.loadedPoints));
    }

    // Calculate ideal window
    const idealWindow = this.calculateLoadWindow(time, param);
    const idealKeys = new Set(idealWindow.map(ts => this.makeKey(param, ts)));

    // Find what needs loading (prioritize current pair)
    const toLoad = idealWindow.filter(ts => !this.slots.has(this.makeKey(param, ts)));
    const priorityTimesteps = [t0, t1].filter(ts => !this.slots.has(this.makeKey(param, ts)));
    const otherTimesteps = toLoad.filter(ts => ts !== t0 && ts !== t1);
    const orderedToLoad = [...priorityTimesteps, ...otherTimesteps];

    // Find eviction candidates (outside ideal window, sorted by distance)
    const evictionCandidates = [...this.slots.entries()]
      .filter(([key, slot]) => slot.param === param && !idealKeys.has(key))
      .sort((a, b) => {
        const distA = Math.abs(this.timestepService.toDate(a[1].timestep).getTime() - time.getTime());
        const distB = Math.abs(this.timestepService.toDate(b[1].timestep).getTime() - time.getTime());
        return distB - distA; // Furthest first
      });

    // Load new timesteps (one at a time to avoid WASM OOM)
    for (const timestep of orderedToLoad) {
      const key = this.makeKey(param, timestep);
      if (this.loadingKeys.has(key)) continue;
      if (this.slots.has(key)) continue;

      // Only one concurrent load
      if (this.loadingKeys.size > 0) break;

      // Get slot index - evict if needed
      let slotIndex: number;
      if (this.freeSlotIndices.length > 0) {
        slotIndex = this.freeSlotIndices.pop()!;
      } else if (evictionCandidates.length > 0) {
        const [evictKey, evictSlot] = evictionCandidates.shift()!;
        console.log(`[Slot] Evicting ${evictKey} for ${key}`);
        this.slots.delete(evictKey);
        this.timestepService.setGpuUnloaded(param, evictSlot.timestep);
        slotIndex = evictSlot.slotIndex;
      } else {
        break; // No slots available
      }

      this.loadingKeys.add(key);
      this.slots.set(key, { timestep, param, slotIndex, loaded: false, loadedPoints: 0 });
      this.loadTimestep(param, timestep, slotIndex, key);
    }
  }

  /** Calculate ideal load window around time */
  private calculateLoadWindow(time: Date, param: TParam): TTimestep[] {
    const [t0, t1] = this.timestepService.adjacent(time);
    const window: TTimestep[] = [t0, t1];

    let pastCursor = this.timestepService.prev(t0);
    let futureCursor = this.timestepService.next(t1);

    while (window.length < this.maxSlots) {
      const added = this.addNextSlot(window, pastCursor, futureCursor, param);
      if (!added) break;

      // Update cursors
      if (futureCursor && window.includes(futureCursor)) {
        futureCursor = this.timestepService.next(futureCursor);
      }
      if (pastCursor && window.includes(pastCursor)) {
        pastCursor = this.timestepService.prev(pastCursor);
      }
    }

    return window;
  }

  /** Add next slot based on strategy */
  private addNextSlot(
    window: TTimestep[],
    pastCursor: TTimestep | null,
    futureCursor: TTimestep | null,
    _param: TParam
  ): boolean {
    const canAddFuture = futureCursor && this.isInDataWindow(futureCursor);
    const canAddPast = pastCursor && this.isInDataWindow(pastCursor);

    switch (this.strategy) {
      case 'future-first':
        if (canAddFuture) { window.push(futureCursor!); return true; }
        if (canAddPast) { window.push(pastCursor!); return true; }
        return false;

      case 'past-first':
        if (canAddPast) { window.push(pastCursor!); return true; }
        if (canAddFuture) { window.push(futureCursor!); return true; }
        return false;

      case 'alternate':
      default:
        const t0 = window[0]!;
        const futureCount = window.filter(ts => ts > t0).length;
        const pastCount = window.filter(ts => ts < t0).length;

        if (futureCount <= pastCount && canAddFuture) {
          window.push(futureCursor!);
          return true;
        }
        if (canAddPast) {
          window.push(pastCursor!);
          return true;
        }
        if (canAddFuture) {
          window.push(futureCursor!);
          return true;
        }
        return false;
    }
  }

  /** Check if timestep is within data window */
  private isInDataWindow(timestep: TTimestep): boolean {
    return timestep >= this.dataWindowStart && timestep <= this.dataWindowEnd;
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

      await this.queueService.submitTimestepOrders(
        [order],
        (_order, slice) => {
          if (slice.done) {
            this.onDataReceived(param, timestep, slice.data);
          }
        }
      );

    } catch (err) {
      console.warn(`[Slot] Failed to load ${param}:${timestep}:`, err);
    } finally {
      this.loadingKeys.delete(key);
      // Trigger re-evaluation to load next
      this.onTimeChange(this.stateService.getTime());
    }
  }

  /** Called when data arrives - upload to GPU */
  private onDataReceived(param: TParam, timestep: TTimestep, data: Float32Array): void {
    const key = this.makeKey(param, timestep);
    const slot = this.slots.get(key);
    if (!slot) return;

    const renderer = this.renderService.getRenderer();
    renderer.uploadTempDataToSlot(data, slot.slotIndex);

    slot.loaded = true;
    slot.loadedPoints = data.length;

    this.timestepService.setGpuLoaded(param, timestep);
    this.slotsVersion.value++;
    console.log(`[Slot] Loaded ${key} → slot ${slot.slotIndex}`);

    this.updateShaderIfReady(param);
  }

  /** Update shader slots if both timesteps ready */
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
    // Set data window from discovered timesteps
    this.dataWindowStart = this.timestepService.first();
    this.dataWindowEnd = this.timestepService.last();
    console.log(`[Slot] Data window: ${this.dataWindowStart} - ${this.dataWindowEnd}`);

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

  /** Get data window */
  getDataWindow(): { start: TTimestep; end: TTimestep } {
    return { start: this.dataWindowStart, end: this.dataWindowEnd };
  }

  /** Set loading strategy */
  setStrategy(strategy: LoadingStrategy): void {
    this.strategy = strategy;
    console.log(`[Slot] Strategy: ${strategy}`);
  }

  /** Get current strategy */
  getStrategy(): LoadingStrategy {
    return this.strategy;
  }

  /** Get max slots */
  getMaxSlots(): number {
    return this.maxSlots;
  }

  /** Get current slot count */
  getSlotCount(): number {
    return this.slots.size;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
    this.slots.clear();
  }
}
