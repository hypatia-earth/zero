/**
 * GPU State - Manages which timesteps are loaded on GPU
 *
 * Tracks per-param GPU texture state. Updated by SlotService
 * when textures are uploaded or evicted.
 */

import type { Signal } from '@preact/signals-core';
import type { TTimestep } from '../../config/types';
import type { TimestepState } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// State Updates
// ─────────────────────────────────────────────────────────────────────────────

export function setGpuLoaded(
  state: Signal<TimestepState>,
  param: string,
  timestep: TTimestep
): void {
  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.gpu.add(timestep);
  state.value = { ...current };
}

export function setGpuUnloaded(
  state: Signal<TimestepState>,
  param: string,
  timestep: TTimestep
): void {
  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.gpu.delete(timestep);
  state.value = { ...current };
}

/** Clear all GPU state for a param (used when shrinking slots) */
export function clearGpuState(
  state: Signal<TimestepState>,
  param: string
): void {
  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.gpu.clear();
  state.value = { ...current };
}

/** Set GPU state for a param (used after smart shrink) */
export function setGpuState(
  state: Signal<TimestepState>,
  param: string,
  timesteps: Set<TTimestep>
): void {
  const current = state.value;
  const paramState = current.params.get(param);
  if (!paramState) return;

  paramState.gpu.clear();
  for (const ts of timesteps) {
    paramState.gpu.add(ts);
  }
  state.value = { ...current };
}
