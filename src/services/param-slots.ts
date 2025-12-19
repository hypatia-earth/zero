/**
 * ParamSlots - Per-parameter slot state management
 *
 * Factory function creates isolated state for each weather layer.
 * Manages: slot allocation, loading tracking, active pair state.
 * SlotService orchestrates multiple ParamSlots instances.
 */

import { signal } from '@preact/signals-core';
import type { TTimestep } from '../config/types';

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

  // Loading tracking
  isLoading(timestep: TTimestep): boolean;
  setLoading(timesteps: TTimestep[]): void;
  clearLoading(timestep: TTimestep): void;

  // Queries
  hasSlot(timestep: TTimestep): boolean;
  getSlot(timestep: TTimestep): Slot | undefined;

  // Active timesteps (0, 1, or 2) ordered by time
  getActiveTimesteps(): TTimestep[];
  setActiveTimesteps(ts: TTimestep[]): void;

  // Resize
  grow(newTotal: number): void;

  // Cleanup
  dispose(): void;
}

/** Short timestep format for logs: "MM-DDTHH" */
const fmt = (ts: TTimestep) => ts.slice(5, 13);

export function createParamSlots(param: string, timeslots: number): ParamSlots {
  const freeIndices = Array.from({ length: timeslots }, (_, i) => i);
  const wanted = signal<WantedState | null>(null);
  const slots = new Map<TTimestep, Slot>();
  const loadingKeys = new Set<TTimestep>();
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

      // Need to evict - find furthest from reference time
      const candidates = [...slots.entries()]
        .filter(([, slot]) => slot.loaded)
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
      console.log(`[Slot] ${P} evict ${fmt(evictTs)} for ${fmt(timestep)}`);
      slots.delete(evictTs);
      return { slotIndex: evictSlot.slotIndex, evicted: evictTs, evictedSlotIndex: evictSlot.slotIndex };
    },

    markLoaded(timestep, slotIndex, loadedPoints) {
      slots.set(timestep, { timestep, slotIndex, loaded: true, loadedPoints });
      console.log(`[Slot] ${P} loaded ${fmt(timestep)} → slot ${slotIndex} (${slots.size}/${capacity})`);
    },

    isLoading: (ts) => loadingKeys.has(ts),

    setLoading(timesteps) {
      loadingKeys.clear();
      for (const ts of timesteps) loadingKeys.add(ts);
    },

    clearLoading: (ts) => loadingKeys.delete(ts),

    hasSlot: (ts) => slots.has(ts),
    getSlot: (ts) => slots.get(ts),

    getActiveTimesteps: () => activeTimesteps,
    setActiveTimesteps: (ts) => { activeTimesteps = ts; },

    grow(newTotal) {
      if (newTotal <= capacity) return;
      for (let i = capacity; i < newTotal; i++) {
        freeIndices.push(i);
      }
      console.log(`[Slot] ${P} grew: ${capacity} → ${newTotal} slots (${slots.size} preserved)`);
      capacity = newTotal;
    },

    dispose() {
      slots.clear();
      loadingKeys.clear();
      freeIndices.length = 0;
      activeTimesteps = [];
    },
  };
}
