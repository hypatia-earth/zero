/**
 * DialogService - Floating mode and z-index management for dialogs
 *
 * Individual services (OptionsService, InfoService) manage their own open/close state.
 * DialogService adds:
 * - Floating mode (desktop only) - keeps dialog open on backdrop click
 * - Z-index stacking - clicked dialog goes on top
 */

import m from 'mithril';

export type DialogId = 'options' | 'info';

export class DialogService {
  // Floating state (persists when dialog closes)
  private floatingDialogs = new Set<DialogId>();

  // Z-index per dialog
  private zIndexMap = new Map<DialogId, number>();
  private zCounter = 100;

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

  isFloating(id: DialogId): boolean {
    return this.isDesktop && this.floatingDialogs.has(id);
  }

  getZIndex(id: DialogId): number {
    return this.zIndexMap.get(id) ?? this.zCounter;
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
    this.zCounter++;
    this.zIndexMap.set(id, this.zCounter);
    m.redraw();
  }

  /** Call when dialog opens to set initial z-index */
  onOpen(id: DialogId): void {
    this.bringToFront(id);
  }

  /** Returns true if backdrop click should close dialog */
  shouldCloseOnBackdrop(id: DialogId): boolean {
    return !this.isFloating(id);
  }
}
