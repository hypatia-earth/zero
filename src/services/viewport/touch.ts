/**
 * Touch Input Handler
 *
 * Handles touch events: single finger drag, two finger pinch/pan, tap to zoom
 */

import type { TwoFingerGestureMode } from './gestures';

export interface TouchDragConfig {
  sensitivity: number;
  invert: boolean;
}

export interface TouchPinchConfig {
  speed: number;
  invert: boolean;
}

export interface TouchPanConfig {
  invert: boolean;
}

export interface TouchTapConfig {
  maxDurationMs: number;
  maxDistancePx: number;
  zoomFactor: number;
  animationMs: number;
}

export interface TouchInputCallbacks {
  onDragStart: (clientX: number, clientY: number) => void;
  onDragMove: (pixelVelocityX: number, pixelVelocityY: number) => void;
  onDragEnd: () => void;
  onPinchZoom: (distanceDelta: number) => void;
  onPanTime: (deltaX: number, deltaTime: number) => void;
  onTap: (clientX: number, clientY: number, isDoubleTap: boolean) => void;
  detectTwoFingerGesture: (distanceDelta: number, panDeltaX: number, panDeltaY: number) => TwoFingerGestureMode;
  getTwoFingerMode: () => TwoFingerGestureMode;
  resetTwoFingerGestureAfterIdle: () => void;
  resetTwoFingerGesture: () => void;
}

export class TouchInputHandler {
  private isDragging: boolean = false;
  private touchCount: number = 0;
  private lastTouchDistance: number = 0;
  private lastTouchX: number = 0;
  private lastTouchY: number = 0;
  private lastMouseTime: number = 0;
  private skipFirstTouchMove: boolean = false;

  // Tap detection
  private tapStartTime: number = 0;
  private tapStartX: number = 0;
  private tapStartY: number = 0;

  // Double tap detection
  private lastTapTime: number = 0;
  private lastTapX: number = 0;
  private lastTapY: number = 0;

  // Pan tracking
  private lastPanTime: number = 0;
  private lastPanX: number = 0;

  constructor(
    private callbacks: TouchInputCallbacks,
    private tapConfig: TouchTapConfig
  ) {}

  /**
   * Handle touch start
   */
  handleTouchStart(e: TouchEvent): void {
    this.touchCount = e.touches.length;

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      if (!touch) return;

      this.isDragging = true;
      this.lastTouchX = touch.clientX;
      this.lastTouchY = touch.clientY;
      this.lastMouseTime = performance.now();
      this.tapStartTime = performance.now();
      this.tapStartX = touch.clientX;
      this.tapStartY = touch.clientY;
      this.skipFirstTouchMove = true;

      this.callbacks.onDragStart(touch.clientX, touch.clientY);
    } else if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      if (!touch1 || !touch2) return;

      const dx = touch2.clientX - touch1.clientX;
      const dy = touch2.clientY - touch1.clientY;
      this.lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
      this.lastTouchX = (touch1.clientX + touch2.clientX) / 2;
      this.lastTouchY = (touch1.clientY + touch2.clientY) / 2;
      this.isDragging = false;
    }
  }

  /**
   * Handle touch move
   */
  handleTouchMove(e: TouchEvent): void {
    if (e.touches.length === 1 && this.isDragging) {
      const touch = e.touches[0];
      if (!touch) return;

      if (this.skipFirstTouchMove) {
        this.skipFirstTouchMove = false;
        this.lastMouseTime = performance.now();
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        return;
      }

      const frameTime = performance.now();
      const deltaTime = (frameTime - this.lastMouseTime) / 1000;

      if (deltaTime <= 0 || deltaTime > 0.1) {
        this.lastMouseTime = frameTime;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        return;
      }

      const deltaX = touch.clientX - this.lastTouchX;
      const deltaY = touch.clientY - this.lastTouchY;

      const pixelVelocityX = deltaX / deltaTime;
      const pixelVelocityY = deltaY / deltaTime;
      this.callbacks.onDragMove(pixelVelocityX, pixelVelocityY);

      this.lastMouseTime = frameTime;
      this.lastTouchX = touch.clientX;
      this.lastTouchY = touch.clientY;
    } else if (e.touches.length === 2) {
      e.preventDefault();

      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      if (!touch1 || !touch2) return;

      const dx = touch2.clientX - touch1.clientX;
      const dy = touch2.clientY - touch1.clientY;
      const currentDistance = Math.sqrt(dx * dx + dy * dy);

      const centerX = (touch1.clientX + touch2.clientX) / 2;
      const centerY = (touch1.clientY + touch2.clientY) / 2;

      // Detect gesture mode
      if (this.callbacks.getTwoFingerMode() === 'none' && this.lastTouchDistance > 0 && this.lastTouchX !== 0) {
        const distanceDelta = Math.abs(currentDistance - this.lastTouchDistance);
        const panDeltaX = Math.abs(centerX - this.lastTouchX);
        const panDeltaY = Math.abs(centerY - this.lastTouchY);
        this.callbacks.detectTwoFingerGesture(distanceDelta, panDeltaX, panDeltaY);
      }

      const gestureMode = this.callbacks.getTwoFingerMode();

      // Apply gesture based on locked mode
      if (gestureMode === 'pinch' || gestureMode === 'none') {
        if (this.lastTouchDistance > 0) {
          const distanceDelta = currentDistance - this.lastTouchDistance;

          if (gestureMode === 'pinch') {
            this.callbacks.onPinchZoom(distanceDelta);
          }
        }
      }

      if (gestureMode === 'pan') {
        const now = performance.now();
        if (this.lastPanX !== 0 && this.lastPanTime !== 0) {
          const panDeltaX = centerX - this.lastPanX;
          const panDeltaTime = (now - this.lastPanTime) / 1000;

          if (panDeltaTime > 0) {
            this.callbacks.onPanTime(panDeltaX, panDeltaTime);
          }
        }
        this.lastPanX = centerX;
        this.lastPanTime = now;
      }

      this.lastTouchDistance = currentDistance;
      this.lastTouchX = centerX;
      this.lastTouchY = centerY;

      this.callbacks.resetTwoFingerGestureAfterIdle();
    }
  }

  /**
   * Handle touch end
   */
  handleTouchEnd(e: TouchEvent, tapToZoom: 'off' | 'single' | 'double'): void {
    this.touchCount = e.touches.length;

    if (this.touchCount === 0) {
      this.isDragging = false;
      this.lastTouchDistance = 0;
      this.lastTouchX = 0;
      this.lastTouchY = 0;
      this.lastPanX = 0;
      this.lastPanTime = 0;
      this.callbacks.resetTwoFingerGesture();

      this.callbacks.onDragEnd();
    }

    // Single tap detection
    if (e.changedTouches.length !== 1) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    const tapDuration = performance.now() - this.tapStartTime;
    const dx = touch.clientX - this.tapStartX;
    const dy = touch.clientY - this.tapStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const isTap = tapDuration < this.tapConfig.maxDurationMs && distance < this.tapConfig.maxDistancePx;

    if (isTap && tapToZoom !== 'off') {
      const now = performance.now();
      const timeSinceLastTap = now - this.lastTapTime;
      const dxFromLast = touch.clientX - this.lastTapX;
      const dyFromLast = touch.clientY - this.lastTapY;
      const distFromLast = Math.sqrt(dxFromLast * dxFromLast + dyFromLast * dyFromLast);

      const isDoubleTap = timeSinceLastTap < 300 && distFromLast < 30;

      if (tapToZoom === 'single') {
        e.preventDefault();
        this.callbacks.onTap(touch.clientX, touch.clientY, false);
      } else if (tapToZoom === 'double' && isDoubleTap) {
        e.preventDefault();
        this.callbacks.onTap(touch.clientX, touch.clientY, true);
      }

      this.lastTapTime = now;
      this.lastTapX = touch.clientX;
      this.lastTapY = touch.clientY;
    }
  }

  /**
   * Check if currently dragging
   */
  getIsDragging(): boolean {
    return this.isDragging;
  }
}
