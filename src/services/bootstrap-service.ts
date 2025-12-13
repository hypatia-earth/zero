/**
 * BootstrapService - Step-based initialization with progress tracking
 */

import { signal } from '@preact/signals-core';
import { sleep } from '../utils/sleep';

export type BootstrapStep =
  | 'CAPABILITIES'
  | 'CONFIG'
  | 'DISCOVERY'
  | 'GPU_INIT'
  | 'DATA'
  | 'ACTIVATE';

export interface BootstrapState {
  step: BootstrapStep;
  progress: number;
  label: string;
  error: string | null;
  complete: boolean;
}

const STEP_PROGRESS: Record<BootstrapStep, { start: number; end: number; label: string }> = {
  CAPABILITIES: { start: 0, end: 5, label: 'Checking capabilities...' },
  CONFIG: { start: 5, end: 10, label: 'Loading configuration...' },
  DISCOVERY: { start: 10, end: 15, label: 'Discovering data...' },
  GPU_INIT: { start: 15, end: 25, label: 'Initializing GPU...' },
  DATA: { start: 25, end: 95, label: 'Loading data...' },
  ACTIVATE: { start: 95, end: 100, label: 'Starting...' },
};

export class BootstrapService {
  static readonly state = signal<BootstrapState>({
    step: 'CAPABILITIES',
    progress: 0,
    label: 'Starting...',
    error: null,
    complete: false,
  });

  static setStep(step: BootstrapStep): void {
    const stepInfo = STEP_PROGRESS[step];
    this.state.value = {
      step,
      progress: stepInfo.start,
      label: stepInfo.label,
      error: null,
      complete: false,
    };
  }

  /**
   * Update label and progress bar during DATA step
   * @param label Text to show (e.g., "Loading basemap 3/6...")
   * @param progress Absolute progress percentage (0-100)
   */
  static async updateProgress(label: string, progress: number): Promise<void> {
    this.state.value = {
      ...this.state.value,
      label,
      progress: Math.min(100, Math.max(0, progress)),
    };
    await sleep(10);
  }

  static setError(error: string): void {
    this.state.value = {
      ...this.state.value,
      error,
      label: 'Error',
    };
  }

  static complete(): void {
    this.state.value = {
      step: 'ACTIVATE',
      progress: 100,
      label: 'Ready',
      error: null,
      complete: true,
    };
  }
}
