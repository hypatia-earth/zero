/**
 * Progress - Centralized bootstrap progress with step weights
 *
 * Steps and their weights are defined here. Phases report relative progress
 * within their step (0.0 to 1.0), and Progress calculates absolute percentage.
 * Messages are prospective - they tell user what's ABOUT to happen.
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

/** Step definition with relative weight */
interface StepDef {
  id: BootstrapStep;
  weight: number;
  label: string;
}

/**
 * Bootstrap steps with relative weights.
 * Heavier steps (more work) get higher weights.
 * This is the single source of truth for step ordering and progress distribution.
 */
const STEPS: StepDef[] = [
  { id: 'CAPABILITIES', weight: 5, label: 'Checking capabilities...' },
  { id: 'CONFIG', weight: 5, label: 'Loading configuration...' },
  { id: 'DISCOVERY', weight: 10, label: 'Discovering data...' },
  { id: 'ASSETS', weight: 30, label: 'Loading assets...' },
  { id: 'GPU_INIT', weight: 10, label: 'Initializing GPU...' },
  { id: 'DATA', weight: 35, label: 'Loading weather data...' },
  { id: 'ACTIVATE', weight: 5, label: 'Starting...' },
];

/** Calculate percentage ranges from weights */
function calculateRanges(): Map<BootstrapStep, { start: number; end: number }> {
  const total = STEPS.reduce((sum, s) => sum + s.weight, 0);
  const ranges = new Map<BootstrapStep, { start: number; end: number }>();

  let cursor = 0;
  for (const step of STEPS) {
    const size = (step.weight / total) * 100;
    ranges.set(step.id, { start: cursor, end: cursor + size });
    cursor += size;
  }

  return ranges;
}

const STEP_RANGES = calculateRanges();

export class Progress {
  private progressSleep = defaultConfig.bootstrap.progressSleep;
  private currentStep: BootstrapStep = 'CAPABILITIES';

  readonly state = signal<ProgressState>({
    step: 'CAPABILITIES',
    progress: 0,
    label: 'Starting...',
    error: null,
    complete: false,
  });

  /**
   * Start a new bootstrap step.
   * Called by orchestrator, not by phases.
   */
  startStep(step: BootstrapStep): void {
    this.currentStep = step;
    const range = STEP_RANGES.get(step)!;
    const def = STEPS.find(s => s.id === step)!;

    this.state.value = {
      step,
      progress: range.start,
      label: def.label,
      error: null,
      complete: false,
    };
    m.redraw();
  }

  /**
   * Report sub-progress within current step.
   * @param message - Prospective message (what's about to happen)
   * @param fraction - Progress within step (0.0 to 1.0)
   */
  async sub(message: string, fraction: number): Promise<void>;
  /**
   * Report sub-progress within current step.
   * @param message - Prospective message (what's about to happen)
   * @param current - Current item number (1-based)
   * @param total - Total items
   */
  async sub(message: string, current: number, total: number): Promise<void>;
  async sub(message: string, a: number, b?: number): Promise<void> {
    const fraction = b !== undefined ? a / b : a;
    const range = STEP_RANGES.get(this.currentStep)!;
    const pct = range.start + fraction * (range.end - range.start);

    this.state.value = {
      ...this.state.value,
      label: message,
      progress: Math.min(100, Math.max(0, pct)),
    };
    m.redraw();
    await sleep(this.progressSleep);
  }

  /**
   * Announce and execute work. User sees message BEFORE work starts.
   * @param message - Prospective message
   * @param fraction - Progress within step (0.0 to 1.0)
   * @param work - Async work to execute
   */
  async run<T>(message: string, fraction: number, work: () => Promise<T>): Promise<T> {
    await this.sub(message, fraction);
    return work();
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
