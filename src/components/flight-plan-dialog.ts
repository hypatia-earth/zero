/**
 * FlightPlanDialog - Text-based keyframe editor
 *
 * Opens with keyframes imported from KeyframeManager, formatted as text.
 * Valid edits update KeyframeManager immediately.
 * Invalid edits show red background; KeyframeManager unchanged.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import type { DialogService } from '../services/dialog-service';
import { DialogHeader } from './dialog-header';
import { createKeyframe } from '../services/capture/keyframe';
import { parseFlightPlan, formatFlightPlan } from '../services/capture/flight-plan';

export interface FlightPlanDialogAttrs {
  captureService: CaptureService;
  dialogService: DialogService;
}

export const FlightPlanDialog: m.ClosureComponent<FlightPlanDialogAttrs> = () => {
  let wasOpen = false;
  let windowEl: HTMLElement | null = null;
  let text = '';
  let error: string | null = null;

  return {
    view({ attrs }) {
      const { captureService, dialogService } = attrs;
      const km = captureService.km;

      if (!dialogService.isOpen('flight-plan')) {
        wasOpen = false;
        return null;
      }

      // Import keyframes on open transition
      if (!wasOpen) {
        wasOpen = true;
        text = formatFlightPlan(km.keyframes.value, km.wrap);
        error = null;
      }

      const isFloating = dialogService.isFloating('flight-plan');
      const isTop = dialogService.isTop('flight-plan');
      const isDragging = dialogService.isDragging('flight-plan');
      const dragOffset = dialogService.getDragOffset('flight-plan');

      const windowStyle: Record<string, string> = {};
      if (dragOffset.x !== 0 || dragOffset.y !== 0) {
        windowStyle.transform = `translate(${dragOffset.x}px, ${dragOffset.y}px)`;
      }

      const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';
      const closingClass = dialogService.isClosing('flight-plan') ? 'closing' : '';

      const close = () => dialogService.close('flight-plan');

      const onInput = (e: InputEvent) => {
        text = (e.target as HTMLTextAreaElement).value;
        try {
          const result = parseFlightPlan(text, km.dataWindowStart, km.dataWindowEnd);
          error = null;

          // Update wrap
          km.wrap = result.wrap;

          // Rebuild keyframes: pin first and last
          const newKfs = result.keyframes.map((kf, i, arr) =>
            createKeyframe(kf.time, kf, i === 0 || i === arr.length - 1),
          );
          km.keyframes.value = newKfs;
          km.activeKeyframeId.value = null;
          m.redraw();
        } catch (err) {
          error = (err as Error).message;
        }
      };

      return m('div.dialog.flight-plan', { class: `${floatingClass} ${closingClass}` }, [
        m('div.backdrop', {
          onclick: () => {
            if (dialogService.shouldCloseOnBackdrop('flight-plan')) {
              close();
            }
          },
        }),
        m('div.window', {
          class: isDragging ? 'dragging' : '',
          style: windowStyle,
          onmousedown: () => dialogService.bringToFront('flight-plan'),
          oncreate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
          onupdate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
        }, [
          m(DialogHeader, {
            dialogId: 'flight-plan',
            title: 'Flight Plan',
            dialogService,
            windowEl,
            onClose: close,
          }),
          m('div.content', [
            m('textarea', {
              class: error ? 'error' : '',
              rows: 12,
              spellcheck: false,
              value: text,
              oninput: onInput,
            }),
            error ? m('div.error-message', error) : null,
          ]),
        ]),
      ]);
    },
  };
};
