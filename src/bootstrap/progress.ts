/**
 * Progress - Prospective progress announcements for bootstrap
 *
 * Messages tell the user what is ABOUT to happen, not what just finished.
 * This ensures the user always sees the current operation before it starts.
 */

import { signal } from '@preact/signals-core';
import m from 'mithril';
import { sleep } from '../utils/sleep';
import { defaultConfig } from '../config/defaults';

export type BootstrapStep =
  | 'CAPABILITIES'
  | 'CONFIG'
  | 'DISCOVERY'
  | 'ASSETS'
  | 'GPU_INIT'
  | 'DATA'
  | 'ACTIVATE';

export interface ProgressState {
  step: BootstrapStep;
  progress: number;
  label: string;
  error: string | null;
  complete: boolean;
}

const STEP_INFO: Record<BootstrapStep, { start: number; end: number }> = {
  CAPABILITIES: { start: 0, end: 5 },
  CONFIG: { start: 5, end: 10 },
  DISCOVERY: { start: 10, end: 20 },
  ASSETS: { start: 20, end: 50 },
  GPU_INIT: { start: 50, end: 60 },
  DATA: { start: 60, end: 95 },
  ACTIVATE: { start: 95, end: 100 },
};

export class Progress {
  private progressSleep = defaultConfig.bootstrap.progressSleep;

  readonly state = signal<ProgressState>({
    step: 'CAPABILITIES',
    progress: 0,
    label: 'Starting...',
    error: null,
    complete: false,
  });

  /**
   * Announce what's about to happen, then execute the work.
   * User sees the message BEFORE work starts.
   */
  async run<T>(message: string, pct: number, work: () => Promise<T>): Promise<T> {
    this.state.value = {
      ...this.state.value,
      label: message,
      progress: Math.min(100, Math.max(0, pct)),
    };
    m.redraw();
    await sleep(this.progressSleep);
    return work();
  }

  /**
   * Announce a step without blocking work (for sub-steps)
   */
  async announce(message: string, pct: number): Promise<void> {
    this.state.value = {
      ...this.state.value,
      label: message,
      progress: Math.min(100, Math.max(0, pct)),
    };
    m.redraw();
    await sleep(this.progressSleep);
  }

  /**
   * Set the current bootstrap step
   */
  setStep(step: BootstrapStep, label: string): void {
    const info = STEP_INFO[step];
    this.state.value = {
      step,
      progress: info.start,
      label,
      error: null,
      complete: false,
    };
    m.redraw();
  }

  /**
   * Get progress range for current step (for sub-progress calculations)
   */
  getStepRange(step: BootstrapStep): { start: number; end: number } {
    return STEP_INFO[step];
  }

  /**
   * Set error state
   */
  setError(error: string): void {
    this.state.value = {
      ...this.state.value,
      error,
      label: 'Error',
    };
    m.redraw();
  }

  /**
   * Mark bootstrap as complete
   */
  complete(): void {
    this.state.value = {
      step: 'ACTIVATE',
      progress: 100,
      label: 'Ready',
      error: null,
      complete: true,
    };
    m.redraw();
  }
}
