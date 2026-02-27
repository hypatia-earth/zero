/**
 * OverlayHeader - Shared header bar for capture and flight plan overlays
 *
 * Layout: label (left) | children slot (buttons) | close button (right)
 * Drag: onpointerdown on non-interactive targets calls onDrag + onFocus
 */

import m from 'mithril';

export interface OverlayHeaderAttrs {
  label: string;
  onDrag: (e: PointerEvent) => void;
  onClose: () => void;
}

/** Check if the event target is an interactive element (not a drag surface) */
export function isInteractive(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'SELECT') return true;
  if (target.closest('button, input, a, select')) return true;
  if (target.classList.contains('edge')) return true;
  return false;
}

export const OverlayHeader: m.Component<OverlayHeaderAttrs> = {
  view({ attrs, children }) {
    const { label, onDrag, onClose } = attrs;

    return m('.overlay-header', {
      onpointerdown: (e: PointerEvent) => {
        if (!isInteractive(e.target)) {
          onDrag(e);
        }
      },
    }, [
      m('span.overlay-label', label),
      children,
      m('button.overlay-close', {
        onclick: () => onClose(),
      }, '\u2715'),
    ]);
  },
};
