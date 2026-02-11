/**
 * DialogService - Centralized dialog state management
 *
 * Manages for all dialogs:
 * - Open/close state with optional payload
 * - Floating mode (desktop only) - keeps dialog open on backdrop click
 * - Z-index stacking - clicked dialog goes on top
 * - Close animation state
 */

import m from 'mithril';
import type { OptionFilter } from '../schemas/options.schema';

export type DialogId = 'options' | 'about' | 'create-layer';

/** Payload types for each dialog */
export interface DialogPayloads {
  options: { filter?: OptionFilter };
  about: { page?: string };
  'create-layer': { editLayerId?: string | null };
}

/** Dialogs that have a closing animation */
const ANIMATED_DIALOGS: DialogId[] = ['options', 'about', 'create-layer'];
const ANIMATION_DURATION = 250;

/** Drag state for a dialog */
interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

function createDragState(): DragState {
  return { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
}

export class DialogService {
  // Open dialogs with their payloads
  private openDialogs = new Map<DialogId, unknown>();

  // Dialogs currently in closing animation
  private closingDialogs = new Set<DialogId>();

  // Floating state (persists when dialog closes)
  private floatingDialogs = new Set<DialogId>();

  // Drag state per dialog (persists when dialog closes)
  private dragStates = new Map<DialogId, DragState>();

  // Which floating dialog is on top
  private topDialog: DialogId | null = null;

  // Desktop breakpoint from CSS
  readonly breakpointDesktop: number;

  constructor() {
    // Read breakpoint from CSS variable
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--breakpoint-desktop')
      .trim();
    this.breakpointDesktop = parseInt(value, 10) || 640;
  }

  get isDesktop(): boolean {
    return window.innerWidth >= this.breakpointDesktop;
  }

  // ----------------------------------------------------------
  // Open/Close state
  // ----------------------------------------------------------

  isOpen(id: DialogId): boolean {
    return this.openDialogs.has(id);
  }

  isClosing(id: DialogId): boolean {
    return this.closingDialogs.has(id);
  }

  open<K extends DialogId>(id: K, payload?: DialogPayloads[K]): void {
    this.openDialogs.set(id, payload ?? {});
    this.bringToFront(id);
    m.redraw();
  }

  close(id: DialogId): void {
    if (!this.openDialogs.has(id)) return;

    if (ANIMATED_DIALOGS.includes(id)) {
      // Animated close
      this.closingDialogs.add(id);
      m.redraw();
      setTimeout(() => {
        this.openDialogs.delete(id);
        this.closingDialogs.delete(id);
        m.redraw();
      }, ANIMATION_DURATION);
    } else {
      // Immediate close
      this.openDialogs.delete(id);
      m.redraw();
    }
  }

  getPayload<K extends DialogId>(id: K): DialogPayloads[K] | undefined {
    return this.openDialogs.get(id) as DialogPayloads[K] | undefined;
  }

  // ----------------------------------------------------------
  // Floating mode
  // ----------------------------------------------------------

  isFloating(id: DialogId): boolean {
    return this.isDesktop && this.floatingDialogs.has(id);
  }

  isTop(id: DialogId): boolean {
    return this.topDialog === id;
  }

  toggleFloating(id: DialogId): void {
    if (this.floatingDialogs.has(id)) {
      this.floatingDialogs.delete(id);
    } else {
      this.floatingDialogs.add(id);
    }
    m.redraw();
  }

  bringToFront(id: DialogId): void {
    this.topDialog = id;
    m.redraw();
  }

  /** Returns true if backdrop click should close dialog */
  shouldCloseOnBackdrop(id: DialogId): boolean {
    return !this.isFloating(id);
  }

  // ----------------------------------------------------------
  // Drag state (desktop only)
  // ----------------------------------------------------------

  private getDragState(id: DialogId): DragState {
    let state = this.dragStates.get(id);
    if (!state) {
      state = createDragState();
      this.dragStates.set(id, state);
    }
    return state;
  }

  isDragging(id: DialogId): boolean {
    return this.getDragState(id).isDragging;
  }

  getDragOffset(id: DialogId): { x: number; y: number } {
    const state = this.getDragState(id);
    return { x: state.offsetX, y: state.offsetY };
  }

  resetDragState(id: DialogId): void {
    this.dragStates.set(id, createDragState());
  }

  /**
   * Start dragging a dialog
   * Returns cleanup function to call on mouseup
   */
  startDrag(id: DialogId, e: MouseEvent, windowEl: HTMLElement): () => void {
    if (!this.isDesktop) return () => {};

    const state = this.getDragState(id);
    state.isDragging = true;
    state.startX = e.clientX - state.offsetX;
    state.startY = e.clientY - state.offsetY;

    const onMouseMove = (ev: MouseEvent) => {
      if (!state.isDragging) return;

      // Calculate bounds to keep header in viewport
      const baseX = (window.innerWidth - windowEl.offsetWidth) / 2;
      const baseY = (window.innerHeight - windowEl.offsetHeight) / 2;
      const headerHeight = 56;

      const minX = -baseX;
      const maxX = window.innerWidth - baseX - windowEl.offsetWidth;
      const minY = -baseY;
      const maxY = window.innerHeight - baseY - headerHeight;

      state.offsetX = Math.max(minX, Math.min(maxX, ev.clientX - state.startX));
      state.offsetY = Math.max(minY, Math.min(maxY, ev.clientY - state.startY));
      m.redraw();
    };

    const onMouseUp = () => {
      state.isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return onMouseUp;
  }
}
