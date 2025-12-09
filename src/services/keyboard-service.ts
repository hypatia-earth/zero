/**
 * KeyboardService - Time navigation with arrow keys
 *
 * Arrow alone: ±1 hour (to full hour)
 * Shift+Arrow: ±10 minutes (to 10-min mark)
 * Ctrl/Cmd+Arrow: ±24 hours
 */

import type { StateService } from './state-service';

export class KeyboardService {
  constructor(private stateService: StateService) {
    window.addEventListener('keydown', this.handleKeydown);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;

    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    e.preventDefault();
    const direction = e.code === 'ArrowLeft' ? -1 : 1;
    const currentTime = this.stateService.getTime();
    let newTime: Date;

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + Arrow: ±24 hours
      newTime = this.addDays(currentTime, direction);
    } else if (e.shiftKey) {
      // Shift + Arrow: ±10 minutes (to 10-min mark)
      newTime = this.roundToTenMinutes(currentTime, direction);
    } else {
      // Arrow alone: ±1 hour (to full hour)
      newTime = this.roundToHour(currentTime, direction);
    }

    this.stateService.setTime(newTime);
  };

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private roundToHour(date: Date, direction: 1 | -1): Date {
    const result = new Date(date);
    result.setUTCMinutes(0, 0, 0);
    if (direction === 1) {
      result.setUTCHours(result.getUTCHours() + 1);
    } else {
      // If already at full hour, go back one more
      if (date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
        result.setUTCHours(result.getUTCHours() - 1);
      }
    }
    return result;
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
