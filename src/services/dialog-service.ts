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

/** Size constraints for resizable overlays */
export interface OverlaySizes {
  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;
}

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

  static readonly sizes = {
    capture:    { minW: 324, minH: 244, defaultW: 480, defaultH: 364 } as OverlaySizes,
    flightPlan: { minW: 260, minH: 180, defaultW: 340, defaultH: 300 } as OverlaySizes,
  };

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
    this.openDialogs.set(id, payload ?? {});  // QC-OK: dialogs can have no payload
    this.bringToFront(id);
    m.redraw();
  }

  close(id: DialogId): void {
    if (!this.openDialogs.has(id)) return;

    if (ANIMATED_DIALOGS.includes(id)) {
      // Animated close — keep drag offset during animation so dialog fades in place
      this.closingDialogs.add(id);
      m.redraw();
      setTimeout(() => {
        this.openDialogs.delete(id);
        this.closingDialogs.delete(id);
        this.resetDragState(id);
        m.redraw();
      }, ANIMATION_DURATION);
    } else {
      // Immediate close
      this.openDialogs.delete(id);
      this.closingDialogs.delete(id);
      this.resetDragState(id);
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

  // ----------------------------------------------------------
  // Overlay rect persistence (localStorage)
  // ----------------------------------------------------------

  private static readonly STORAGE_KEY = 'zero:overlay-rects';

  private static loadRects(): Record<string, { x: number; y: number; w: number; h: number }> {
    try { return JSON.parse(localStorage.getItem(DialogService.STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  /** Save an overlay's position and size */
  static saveRect(id: string, rect: { x: number; y: number; w: number; h: number }): void {
    const rects = DialogService.loadRects();
    rects[id] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    localStorage.setItem(DialogService.STORAGE_KEY, JSON.stringify(rects));
  }

  /**
   * Resolve an overlay rect from persisted storage against current viewport.
   * Reads --layout-margin-* CSS variables for safe area insets.
   * 1. Saved as-is if it fits
   * 2. Re-centered with saved size if size fits but position doesn't
   * 3. Centered with defaults
   */
  static resolveRect(id: string, sizes: OverlaySizes): { x: number; y: number; w: number; h: number } {
    const saved = DialogService.loadRects()[id] ?? null;
    const style = getComputedStyle(document.documentElement);
    const mt = parseFloat(style.getPropertyValue('--layout-margin-top')) || 0;
    const mr = parseFloat(style.getPropertyValue('--layout-margin-right')) || 0;
    const mb = parseFloat(style.getPropertyValue('--layout-margin-bottom')) || 0;
    const ml = parseFloat(style.getPropertyValue('--layout-margin-left')) || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (saved && saved.w >= sizes.minW && saved.h >= sizes.minH) {
      if (saved.x >= ml && saved.y >= mt &&
          saved.x + saved.w <= vw - mr && saved.y + saved.h <= vh - mb) {
        return { ...saved };
      }
      const x = Math.round((vw - saved.w) / 2);
      const y = Math.round((vh - saved.h) / 2);
      if (x >= ml && y >= mt && x + saved.w <= vw - mr && y + saved.h <= vh - mb) {
        return { x, y, w: saved.w, h: saved.h };
      }
    }

    const w = sizes.defaultW;
    const h = sizes.defaultH;
    return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
  }
}
