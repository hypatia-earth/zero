/**
 * FlightPlanDialog - Text-based keyframe editor (overlay panel)
 *
 * Opens with keyframes imported from KeyframeManager, formatted as text.
 * Valid edits update KeyframeManager immediately.
 * Invalid edits show red background; KeyframeManager unchanged.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import { DialogService } from '../services/dialog-service';
import { OverlayHeader } from './overlay-header';
import { createKeyframe } from '../services/capture/keyframe';
import { parseFlightPlan, formatFlightPlan } from '../services/capture/flight-plan';

export interface FlightPlanDialogAttrs {
  captureService: CaptureService;
}

const FP = DialogService.sizes.flightPlan;
const RECT_ID = 'flightPlan';

export const FlightPlanDialog: m.ClosureComponent<FlightPlanDialogAttrs> = () => {
  let wasOpen = false;
  let text = '';
  let error: string | null = null;
  let hasFocus = false;

  // Panel position and size (absolute px)
  let posX = 0;
  let posY = 0;
  let width = FP.defaultW;
  let height = FP.defaultH;

  function saveRect(): void {
    DialogService.saveRect(RECT_ID, { x: posX, y: posY, w: width, h: height });
  }

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
      saveRect();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function startResize(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = width;
    const startH = height;

    const onMove = (ev: PointerEvent) => {
      width = Math.max(FP.minW, startW + ev.clientX - startX);
      height = Math.max(FP.minH, startH + ev.clientY - startY);
      m.redraw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      saveRect();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  return {
    view({ attrs }) {
      const { captureService } = attrs;
      const km = captureService.km;

      if (!captureService.flightPlanOpen.value) {
        if (wasOpen) {
          saveRect();
          wasOpen = false;
        }
        return null;
      }

      // Restore rect and import keyframes on open transition
      if (!wasOpen) {
        wasOpen = true;
        hasFocus = false;
        const rect = DialogService.resolveRect(RECT_ID, FP);
        posX = rect.x;
        posY = rect.y;
        width = rect.w;
        height = rect.h;
        text = formatFlightPlan(km.keyframes.value, km.wrap, km.dataWindowStart, km.dataWindowEnd);
        error = null;
      }

      // Sync back from capture bar when textarea is not focused
      if (!hasFocus && !error) {
        text = formatFlightPlan(km.keyframes.value, km.wrap, km.dataWindowStart, km.dataWindowEnd);
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
          width: `${width}px`,
          height: `${height}px`,
        },
        onpointerdown: (e: PointerEvent) => e.stopPropagation(),
      }, [
        m(OverlayHeader, {
          label: 'Flight Plan',
          onDrag: startDrag,
          onClose: () => { saveRect(); captureService.flightPlanOpen.value = false; },
        }),
        m('.flight-plan-content', [
          m('textarea', {
            class: error ? 'error' : '',
            spellcheck: false,
            value: text,
            oninput: onInput,
            onfocus: () => { hasFocus = true; },
            onblur: () => {
              hasFocus = false;
              text = formatFlightPlan(km.keyframes.value, km.wrap, km.dataWindowStart, km.dataWindowEnd);
              error = null;
            },
          }),
          m('.flight-plan-status', { class: error ? 'status-error' : 'status-ok' },
            error ?? `${km.keyframes.value.length} keyframes parsed OK`,
          ),
        ]),
        m('.flight-plan-resize', {
          onpointerdown: startResize,
        }),
      ]);
    },
  };
};
