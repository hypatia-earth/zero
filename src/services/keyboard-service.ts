/**
 * KeyboardService - Time navigation with arrow keys
 *
 * Arrow alone: snap to next/previous timestep
 * Shift+Arrow: ±10 minutes (to 10-min mark)
 * Alt+Arrow: ±24 hours
 * Alt+Shift+Arrow: ±1 minute
 */

import type { StateService } from './state-service';
import type { TimestepService } from './timestep';
import { parseTimestep } from '../utils/timestep';
import { toggleFullscreen } from '../components/fullscreen-panel';

export class KeyboardService {
  constructor(
    private stateService: StateService,
    private timestepService: TimestepService,
  ) {
    window.addEventListener('keydown', this.handleKeydown);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // F key: toggle fullscreen
    if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;

    e.preventDefault();
    const direction = e.code === 'ArrowLeft' ? -1 : 1;
    const currentTime = this.stateService.viewState.value.time;
    let newTime: Date;

    if (e.altKey && e.shiftKey) {
      // Alt + Shift + Arrow: ±1 minute
      newTime = this.addMinutes(currentTime, direction);
    } else if (e.altKey) {
      // Alt + Arrow: ±24 hours (Ctrl/Cmd intercepted by browser)
      newTime = this.addDays(currentTime, direction);
    } else if (e.shiftKey) {
      // Shift + Arrow: ±10 minutes (to 10-min mark)
      newTime = this.roundToTenMinutes(currentTime, direction);
    } else {
      // Arrow alone: snap to next/previous timestep
      newTime = this.snapToTimestep(currentTime, direction);
    }

    this.stateService.setTime(newTime);
  };

  private addMinutes(date: Date, minutes: number): Date {
    const result = new Date(date);
    result.setUTCMinutes(result.getUTCMinutes() + minutes);
    return result;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private snapToTimestep(date: Date, direction: 1 | -1): Date {
    // adjacent returns [t0, t1] where t0 < time <= t1
    // When exactly on timestep T, returns [T-1, T]
    const [t0, t1] = this.timestepService.adjacent(date);
    const t1Date = parseTimestep(t1);

    if (direction === 1) {
      // Forward: if on t1, get the one after
      if (date.getTime() === t1Date.getTime()) {
        const [, next] = this.timestepService.adjacent(new Date(t1Date.getTime() + 1));
        return parseTimestep(next);
      }
      return t1Date;
    } else {
      // Backward: go to t0
      return parseTimestep(t0);
    }
  }

  private roundToTenMinutes(date: Date, direction: 1 | -1): Date {
    const result = new Date(date);
    const minutes = result.getUTCMinutes();
    const roundedMinutes = Math.floor(minutes / 10) * 10;
    result.setUTCMinutes(roundedMinutes, 0, 0);

    if (direction === 1) {
      result.setUTCMinutes(result.getUTCMinutes() + 10);
    } else {
      // If already at 10-min mark, go back one more
      if (minutes === roundedMinutes && date.getUTCSeconds() === 0) {
        result.setUTCMinutes(result.getUTCMinutes() - 10);
      }
    }
    return result;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeydown);
  }
}
