/**
 * Gesture Detector
 *
 * Detects and locks wheel gesture direction (horizontal vs vertical)
 * and two-finger touch gesture mode (pinch vs pan)
 */

export type GestureDirection = 'none' | 'vertical' | 'horizontal';
export type TwoFingerGestureMode = 'none' | 'pinch' | 'pan';

export interface GestureDetectorConfig {
  idleResetMs: number;
  twoFingerThreshold: number;
}

export class GestureDetector {
  private gestureMode: GestureDirection = 'none';
  private gestureTimeout: number | null = null;
  private twoFingerGestureMode: TwoFingerGestureMode = 'none';
  private twoFingerGestureTimeout: number | null = null;

  constructor(private config: GestureDetectorConfig) {}

  /**
   * Detect and lock wheel gesture direction
   */
  detectWheelGesture(deltaX: number, deltaY: number): GestureDirection {
    const absY = Math.abs(deltaY);
    const absX = Math.abs(deltaX);

    // Clear existing timeout
    if (this.gestureTimeout !== null) {
      clearTimeout(this.gestureTimeout);
    }

    // Determine gesture mode only on first event (lock it in)
    if (this.gestureMode === 'none') {
      if (absX > absY) {
        this.gestureMode = 'horizontal';
      } else {
        this.gestureMode = 'vertical';
      }
    }

    // Set timeout to reset gesture mode
    this.gestureTimeout = window.setTimeout(() => {
      this.gestureMode = 'none';
      this.gestureTimeout = null;
    }, this.config.idleResetMs);

    return this.gestureMode;
  }

  /**
   * Detect two-finger gesture mode (pinch vs pan)
   */
  detectTwoFingerGesture(
    distanceDelta: number,
    panDeltaX: number,
    panDeltaY: number
  ): TwoFingerGestureMode {
    // Only detect if not already locked
    if (this.twoFingerGestureMode === 'none') {
      const threshold = this.config.twoFingerThreshold;

      if (distanceDelta > threshold && distanceDelta > panDeltaX) {
        this.twoFingerGestureMode = 'pinch';
      } else if (panDeltaX > threshold && panDeltaX > distanceDelta && panDeltaX > panDeltaY * 2) {
        this.twoFingerGestureMode = 'pan';
      }
    }

    return this.twoFingerGestureMode;
  }

  /**
   * Get current two-finger gesture mode
   */
  getTwoFingerMode(): TwoFingerGestureMode {
    return this.twoFingerGestureMode;
  }

  /**
   * Reset two-finger gesture mode after idle
   */
  resetTwoFingerGestureAfterIdle(): void {
    if (this.twoFingerGestureTimeout !== null) {
      clearTimeout(this.twoFingerGestureTimeout);
    }
    this.twoFingerGestureTimeout = window.setTimeout(() => {
      this.twoFingerGestureMode = 'none';
      this.twoFingerGestureTimeout = null;
    }, 100);
  }

  /**
   * Force reset two-finger gesture mode
   */
  resetTwoFingerGesture(): void {
    this.twoFingerGestureMode = 'none';
    if (this.twoFingerGestureTimeout !== null) {
      clearTimeout(this.twoFingerGestureTimeout);
      this.twoFingerGestureTimeout = null;
    }
  }

  /**
   * Clean up timeouts
   */
  dispose(): void {
    if (this.gestureTimeout !== null) {
      clearTimeout(this.gestureTimeout);
      this.gestureTimeout = null;
    }
    if (this.twoFingerGestureTimeout !== null) {
      clearTimeout(this.twoFingerGestureTimeout);
      this.twoFingerGestureTimeout = null;
    }
  }
}
