/**
 * ParamSlots - Per-parameter slot state management
 *
 * Factory function creates isolated state for each weather layer.
 * Manages: slot allocation, loading tracking, active pair state.
 * SlotService orchestrates multiple ParamSlots instances.
 */

import { signal } from '@preact/signals-core';
import type { TTimestep } from '../config/types';

const DEBUG = false;

/** What timesteps the current time needs */
export interface WantedState {
  mode: 'single' | 'pair';
  priority: TTimestep[];    // [exactTs] for single, [t0, t1] for pair
  window: TTimestep[];      // Full prefetch window
}

export interface Slot {
  timestep: TTimestep;
  slotIndex: number;
  loaded: boolean;
  loadedPoints: number;
  slabsCount?: number;      // Total slabs expected (undefined = single-slab param)
}

export interface ParamSlots {
  readonly wanted: ReturnType<typeof signal<WantedState | null>>;

  // Slot allocation - returns slotIndex and evicted info (if any)
  allocateSlot(
    timestep: TTimestep,
    referenceTime: Date,
    toDate: (ts: TTimestep) => Date
  ): { slotIndex: number; evicted: TTimestep | null; evictedSlotIndex: number | null } | null;

  // Slot state
  markLoaded(timestep: TTimestep, slotIndex: number, loadedPoints: number): void;

  // Slab tracking (for multi-param layers like wind with U+V)
  markSlabLoaded(timestep: TTimestep, slabIndex: number): void;
  areAllSlabsLoaded(slotIndex: number): boolean;

  // Loading tracking
  isLoading(timestep: TTimestep): boolean;
  setLoading(timesteps: TTimestep[]): void;
  clearLoading(timestep: TTimestep): void;

  // Queries
  hasSlot(timestep: TTimestep): boolean;
  getSlot(timestep: TTimestep): Slot | undefined;
  getTimeslotMapping(): Map<TTimestep, number>;

  // Active timesteps (0, 1, or 2) ordered by time
  getActiveTimesteps(): TTimestep[];
  setActiveTimesteps(ts: TTimestep[]): void;

  // Resize
  grow(newTotal: number): void;
  shrink(newTotal: number, keptMapping: Map<TTimestep, number>): void;

  // Cleanup
  dispose(): void;
}

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

export function createParamSlots(param: string, timeslots: number, slabsCount?: number): ParamSlots {
  const freeIndices = Array.from({ length: timeslots }, (_, i) => i);
  const wanted = signal<WantedState | null>(null);
  const slots = new Map<TTimestep, Slot>();
  const loadingKeys = new Set<TTimestep>();
  const slabsLoaded = new Map<number, Set<number>>();  // slotIndex → Set<slabIndex>
  let activeTimesteps: TTimestep[] = [];
  let capacity = timeslots;

  const P = param.slice(0, 4).toUpperCase();

  return {
    wanted,

    allocateSlot(timestep, referenceTime, toDate) {
      // Already has slot?
      const existing = slots.get(timestep);
      if (existing) return { slotIndex: existing.slotIndex, evicted: null, evictedSlotIndex: null };

      // Free slot available?
      if (freeIndices.length > 0) {
        return { slotIndex: freeIndices.pop()!, evicted: null, evictedSlotIndex: null };
      }

      // Need to evict - find furthest from reference time, but protect slots in wanted window
      const wantedWindow = new Set(wanted.value?.window ?? []);
      const candidates = [...slots.entries()]
        .filter(([ts, slot]) => slot.loaded && !wantedWindow.has(ts))  // Don't evict slots in window
        .sort((a, b) => {
          const distA = Math.abs(toDate(a[0]).getTime() - referenceTime.getTime());
          const distB = Math.abs(toDate(b[0]).getTime() - referenceTime.getTime());
          return distB - distA; // Furthest first
        });

      if (candidates.length === 0) {
        console.warn(`[Slot] ${P} no slots available for ${fmt(timestep)}`);
        return null;
      }

      const [evictTs, evictSlot] = candidates[0]!;
      DEBUG && console.log(`[Slot] ${P} evict ${fmt(evictTs)} for ${fmt(timestep)}`);
      slots.delete(evictTs);
      slabsLoaded.delete(evictSlot.slotIndex);  // Clear slab tracking for evicted slot
      return { slotIndex: evictSlot.slotIndex, evicted: evictTs, evictedSlotIndex: evictSlot.slotIndex };
    },

    markLoaded(timestep, slotIndex, loadedPoints) {
      // For single-slab layers (slabsCount undefined or 1): mark loaded immediately
      // For multi-slab layers: create slot but don't mark loaded until all slabs complete
      const isMultiSlab = slabsCount !== undefined && slabsCount > 1;
      const slot: Slot = {
        timestep,
        slotIndex,
        loaded: !isMultiSlab,  // Only true for single-slab layers
        loadedPoints
      };
      if (slabsCount !== undefined) slot.slabsCount = slabsCount;
      slots.set(timestep, slot);

      if (isMultiSlab) {
        DEBUG && console.log(`[Slot] ${P} allocated ${fmt(timestep)} → slot ${slotIndex} (waiting for ${slabsCount} slabs)`);
      } else {
        DEBUG && console.log(`[Slot] ${P} loaded ${fmt(timestep)} → slot ${slotIndex} (${slots.size}/${capacity})`);
      }
    },

    markSlabLoaded(timestep, slabIndex) {
      const slot = slots.get(timestep);
      if (!slot) {
        console.warn(`[Slot] ${P} markSlabLoaded called for unknown timestep ${fmt(timestep)}`);
        return;
      }

      if (!slabsLoaded.has(slot.slotIndex)) {
        slabsLoaded.set(slot.slotIndex, new Set());
      }
      slabsLoaded.get(slot.slotIndex)!.add(slabIndex);

      const loadedCount = slabsLoaded.get(slot.slotIndex)!.size;
      DEBUG && console.log(`[Slot] ${P} slab ${slabIndex} loaded for ${fmt(timestep)} → slot ${slot.slotIndex} (${loadedCount}/${slabsCount})`);

      // Check if all slabs are now loaded
      if (slabsCount !== undefined && loadedCount === slabsCount) {
        slot.loaded = true;
        DEBUG && console.log(`[Slot] ${P} ALL slabs loaded for ${fmt(timestep)} → slot ${slot.slotIndex} (${slots.size}/${capacity})`);
      }
    },

    areAllSlabsLoaded(slotIndex) {
      if (slabsCount === undefined) return true;  // Single-slab params always ready
      const loaded = slabsLoaded.get(slotIndex);
      return loaded !== undefined && loaded.size === slabsCount;
    },

    isLoading: (ts) => loadingKeys.has(ts),

    setLoading(timesteps) {
      loadingKeys.clear();
      for (const ts of timesteps) loadingKeys.add(ts);
    },

    clearLoading: (ts) => loadingKeys.delete(ts),

    hasSlot: (ts) => slots.has(ts),
    getSlot: (ts) => slots.get(ts),
    getTimeslotMapping: () => {
      const mapping = new Map<TTimestep, number>();
      for (const [ts, slot] of slots) {
        if (slot.loaded) mapping.set(ts, slot.slotIndex);
      }
      return mapping;
    },

    getActiveTimesteps: () => activeTimesteps,
    setActiveTimesteps: (ts) => { activeTimesteps = ts; },

    grow(newTotal) {
      if (newTotal <= capacity) return;
      for (let i = capacity; i < newTotal; i++) {
        freeIndices.push(i);
      }
      DEBUG && console.log(`[Slot] ${P} grew: ${capacity} → ${newTotal} slots (${slots.size} preserved)`);
      capacity = newTotal;
    },

    shrink(newTotal, keptMapping) {
      const oldSize = slots.size;

      // Rebuild slots from kept mapping
      const newSlots = new Map<TTimestep, Slot>();
      for (const [ts, newSlotIndex] of keptMapping) {
        const existing = slots.get(ts);
        if (existing) {
          newSlots.set(ts, { ...existing, slotIndex: newSlotIndex });
        }
      }
      slots.clear();
      for (const [ts, slot] of newSlots) {
        slots.set(ts, slot);
      }

      // Rebuild free indices
      const usedIndices = new Set(keptMapping.values());
      freeIndices.length = 0;
      for (let i = 0; i < newTotal; i++) {
        if (!usedIndices.has(i)) freeIndices.push(i);
      }

      // Clear loading state and slabs for evicted
      loadingKeys.clear();
      slabsLoaded.clear();

      // Clear active if references evicted slots
      if (activeTimesteps.some(ts => !keptMapping.has(ts))) {
        activeTimesteps = [];
      }

      capacity = newTotal;
      DEBUG && console.log(`[Slot] ${P} shrunk: ${oldSize} → ${slots.size} slots (capacity ${newTotal})`);
    },

    dispose() {
      slots.clear();
      loadingKeys.clear();
      slabsLoaded.clear();
      freeIndices.length = 0;
      activeTimesteps = [];
    },
  };
}
