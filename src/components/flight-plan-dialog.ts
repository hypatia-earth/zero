/**
 * FlightPlanDialog - Text-based keyframe editor (overlay panel)
 *
 * Opens with keyframes imported from KeyframeManager, formatted as text.
 * Valid edits update KeyframeManager immediately.
 * Invalid edits show red background; KeyframeManager unchanged.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import { OverlayHeader } from './overlay-header';
import { createKeyframe } from '../services/capture/keyframe';
import { parseFlightPlan, formatFlightPlan } from '../services/capture/flight-plan';

export interface FlightPlanDialogAttrs {
  captureService: CaptureService;
}

export const FlightPlanDialog: m.ClosureComponent<FlightPlanDialogAttrs> = () => {
  let wasOpen = false;
  let text = '';
  let error: string | null = null;

  // Drag position (absolute px)
  let posX = 60;
  let posY = 100;

  function startDrag(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX - posX;
    const startY = e.clientY - posY;

    const onMove = (ev: PointerEvent) => {
      posX = ev.clientX - startX;
      posY = ev.clientY - startY;
      m.redraw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  return {
    view({ attrs }) {
      const { captureService } = attrs;
      const km = captureService.km;

      if (!captureService.flightPlanOpen.value) {
        wasOpen = false;
        return null;
      }

      // Import keyframes on open transition
      if (!wasOpen) {
        wasOpen = true;
        text = formatFlightPlan(km.keyframes.value, km.wrap);
        error = null;
      }

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

      return m('.flight-plan-overlay', {
        style: {
          left: `${posX}px`,
          top: `${posY}px`,
        },
        onpointerdown: (e: PointerEvent) => e.stopPropagation(),
      }, [
        m(OverlayHeader, {
          label: 'Flight Plan',
          onDrag: startDrag,
          onClose: () => { captureService.flightPlanOpen.value = false; },
        }),
        m('.flight-plan-content', [
          m('textarea', {
            class: error ? 'error' : '',
            rows: 12,
            spellcheck: false,
            value: text,
            oninput: onInput,
          }),
          error ? m('.error-message', error) : null,
        ]),
      ]);
    },
  };
};
