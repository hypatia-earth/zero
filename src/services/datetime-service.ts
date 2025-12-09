/**
 * DateTimeService - Time management for Hypatia Zero
 */

import { signal } from '@preact/signals-core';

export interface DataWindow {
  start: Date;
  end: Date;
  totalHours: number;
}

export class DateTimeService {
  /** Current wall clock time (updates every minute) */
  readonly wallTime = signal<Date>(new Date());

  /** Data window bounds */
  readonly dataWindow = signal<DataWindow>(this.calculateDataWindow(new Date()));

  private intervalId: number | null = null;

  constructor(private dataWindowDays: number = 5) {
    this.startClock();
  }

  private startClock(): void {
    // Update every minute
    this.intervalId = window.setInterval(() => {
      const now = new Date();
      this.wallTime.value = now;

      // Check if we crossed midnight (data window shifts)
      const currentWindow = this.dataWindow.value;
      const newWindow = this.calculateDataWindow(now);
      if (currentWindow.start.getTime() !== newWindow.start.getTime()) {
        this.dataWindow.value = newWindow;
        console.log('[DateTime] Data window shifted to', newWindow.start.toISOString().slice(0, 10));
      }
    }, 60_000);
  }

  private calculateDataWindow(now: Date): DataWindow {
    // Window is centered on today, ±dataWindowDays
    const todayMidnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));

    const start = new Date(todayMidnight);
    start.setUTCDate(start.getUTCDate() - this.dataWindowDays);

    const end = new Date(todayMidnight);
    end.setUTCDate(end.getUTCDate() + this.dataWindowDays + 1);
    end.setUTCMilliseconds(-1); // End of last day

    const totalHours = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60));

    return { start, end, totalHours };
  }

  getWallTime(): Date {
    return this.wallTime.value;
  }

  getDataWindow(): DataWindow {
    return this.dataWindow.value;
  }

  /** Check if a date is within the data window */
  isInDataWindow(date: Date): boolean {
    const window = this.dataWindow.value;
    return date >= window.start && date <= window.end;
  }

  /** Get latest model run time (00z, 06z, 12z, 18z) */
  getLatestModelRun(now: Date = new Date()): Date {
    const hour = now.getUTCHours();
    const runHour = hour >= 18 ? 18 : hour >= 12 ? 12 : hour >= 6 ? 6 : 0;

    const run = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      runHour, 0, 0, 0
    ));

    // If current hour is before first run (0-5), use previous day's 18z
    if (runHour === 0 && hour < 6) {
      run.setUTCDate(run.getUTCDate() - 1);
      run.setUTCHours(18);
    }

    return run;
  }

  dispose(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
