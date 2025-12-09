/**
 * BootstrapService - Step-based initialization with progress tracking
 */

import { signal } from '@preact/signals-core';

export type BootstrapStep =
  | 'CAPABILITIES'
  | 'CONFIG'
  | 'GPU_INIT'
  | 'BASEMAP'
  | 'ACTIVATE'
  | 'LOAD_DATA'
  | 'FINALIZE';

export interface BootstrapState {
  step: BootstrapStep;
  progress: number;
  label: string;
  error: string | null;
  complete: boolean;
}

const STEP_PROGRESS: Record<BootstrapStep, { start: number; label: string }> = {
  CAPABILITIES: { start: 0, label: 'Checking capabilities...' },
  CONFIG: { start: 5, label: 'Loading configuration...' },
  GPU_INIT: { start: 15, label: 'Initializing GPU...' },
  BASEMAP: { start: 30, label: 'Loading basemap...' },
  ACTIVATE: { start: 50, label: 'Starting renderer...' },
  LOAD_DATA: { start: 55, label: 'Loading weather data...' },
  FINALIZE: { start: 95, label: 'Ready' },
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
      complete: step === 'FINALIZE',
    };
  }

  static setProgress(progress: number): void {
    this.state.value = {
      ...this.state.value,
      progress: Math.min(100, Math.max(0, progress)),
    };
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
      step: 'FINALIZE',
      progress: 100,
      label: 'Ready',
      error: null,
      complete: true,
    };
  }
}
