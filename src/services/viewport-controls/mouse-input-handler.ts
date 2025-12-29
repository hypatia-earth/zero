/**
 * Mouse Input Handler
 *
 * Handles mouse events: drag, wheel zoom/time, double-click
 */

import type { GestureDirection } from './gesture-detector';

export interface MouseDragConfig {
  sensitivity: number;
  invert: boolean;
}

export interface MouseWheelZoomConfig {
  speed: number;
  invert: boolean;
}

export interface MouseWheelTimeConfig {
  invert: boolean;
}

export interface MouseDoubleClickConfig {
  zoomFactor: number;
  animationMs: number;
}

export interface MouseInputCallbacks {
  onDragStart: (clientX: number, clientY: number) => void;
  onDragMove: (pixelVelocityX: number, pixelVelocityY: number) => void;
  onDragEnd: () => void;
  onWheelZoom: (deltaY: number, clientX: number, clientY: number) => void;
  onWheelTime: (deltaX: number) => void;
  onDoubleClick: (clientX: number, clientY: number) => void;
  onClick: (e: MouseEvent) => void;
  detectWheelGesture: (deltaX: number, deltaY: number) => GestureDirection;
  isPointOnGlobe: (clientX: number, clientY: number) => boolean;
}

export class MouseInputHandler {
  private isDragging: boolean = false;
  private lastMouseTime: number = 0;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  private currentMouseX: number = 0;
  private currentMouseY: number = 0;

  constructor(private callbacks: MouseInputCallbacks) {}

  /**
   * Get current mouse position
   */
  getCurrentPosition(): { x: number; y: number } {
    return { x: this.currentMouseX, y: this.currentMouseY };
  }

  /**
   * Handle mouse down
   */
  handleMouseDown(e: MouseEvent): void {
    this.currentMouseX = e.clientX;
    this.currentMouseY = e.clientY;

    if (e.button === 0) {
      this.isDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.lastMouseTime = performance.now();

      this.callbacks.onDragStart(e.clientX, e.clientY);
    }
  }

  /**
   * Handle mouse move
   */
  handleMouseMove(e: MouseEvent): void {
    this.currentMouseX = e.clientX;
    this.currentMouseY = e.clientY;

    if (!this.isDragging) return;

    const frameTime = performance.now();
    const deltaTime = (frameTime - this.lastMouseTime) / 1000;

    if (deltaTime <= 0 || deltaTime > 0.1) {
      this.lastMouseTime = frameTime;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      return;
    }

    const deltaX = e.clientX - this.lastMouseX;
    const deltaY = e.clientY - this.lastMouseY;

    const pixelVelocityX = deltaX / deltaTime;
    const pixelVelocityY = deltaY / deltaTime;
    this.callbacks.onDragMove(pixelVelocityX, pixelVelocityY);

    this.lastMouseTime = frameTime;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
  }

  /**
   * Handle mouse up
   */
  handleMouseUp(e: MouseEvent): void {
    if (e.button === 0) {
      this.isDragging = false;
      this.callbacks.onDragEnd();
    }
  }

  /**
   * Handle wheel events
   */
  handleWheel(e: WheelEvent): void {
    const gestureMode = this.callbacks.detectWheelGesture(e.deltaX, e.deltaY);

    if (gestureMode === 'horizontal') {
      e.preventDefault();
      this.callbacks.onWheelTime(e.deltaX);
    } else if (gestureMode === 'vertical') {
      if (!this.callbacks.isPointOnGlobe(this.currentMouseX, this.currentMouseY)) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      this.callbacks.onWheelZoom(e.deltaY, this.currentMouseX, this.currentMouseY);
    }
  }

  /**
   * Handle click
   */
  handleClick(e: MouseEvent): void {
    this.callbacks.onClick(e);
  }

  /**
   * Handle double-click
   */
  handleDoubleClick(e: MouseEvent): void {
    this.callbacks.onDoubleClick(e.clientX, e.clientY);
  }

  /**
   * Check if currently dragging
   */
  getIsDragging(): boolean {
    return this.isDragging;
  }
}
