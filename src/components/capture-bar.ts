/**
 * CaptureBar - Timeline track for animated capture mode
 *
 * 3-row layout:
 *   Row 1: Weather time labels (HH:MM UTC) for each keyframe
 *   Row 2: Track line with keyframe shapes, vertical bars at start/end
 *   Row 3: Anim elapsed time labels (MM:SS) for each keyframe
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import type { StateService } from '../services/state-service';
import { formatTimeHHMM, formatElapsedMMSS, timeToPercent } from '../services/capture/helpers';

interface CaptureBarAttrs {
  captureService: CaptureService;
  stateService: StateService;
}

/** Compute time from x position on track */
function xToTime(clientX: number, trackEl: HTMLElement, start: number, end: number): number {
  const rect = trackEl.getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return start + t * (end - start);
}

const DELETE_THRESHOLD = 20;

export const CaptureBar: m.ClosureComponent<CaptureBarAttrs> = () => {
  let trackEl: HTMLElement | null = null;
  let draggingId: number | null = null;
  let dragStartY = 0;
  let pendingDelete = false;

  return {
    view({ attrs }) {
      const { captureService, stateService } = attrs;
      const { km, animated } = captureService;
      const isAnimated = animated.captureType.value === 'animated';
      if (!isAnimated) return null;

      const keyframes = km.keyframes.value;
      const activeId = km.activeKeyframeId.value;
      const start = km.dataWindowStart;
      const end = km.dataWindowEnd;
      const currentTime = stateService.viewState.value.time.getTime();
      const clampedTimePos = timeToPercent(currentTime, start, end);
      const isDryRunning = animated.dryRunning.value;

      // Animation duration from options (seconds → ms)
      const animDurationMs = Number(captureService.animated['options'].duration) * 1000;

      return m('.capture-bar', [
        // Progress (dry run only)
        isDryRunning
          ? m('.capture-bar-buttons',
              m('span.capture-bar-progress',
                `${captureService.frameIndex.value}/${Number(captureService.totalFrames.value)}`))
          : null,

        // 3-row timeline
        m('.capture-bar-timeline', [

          // Row 1: Weather time labels
          m('.capture-bar-row.capture-bar-weather-times', keyframes.map(kf => {
            const pos = timeToPercent(kf.time, start, end);
            return m('span.capture-bar-time-label', {
              class: kf.id === activeId ? 'active' : '',
              style: { left: `${pos}%` },
            }, formatTimeHHMM(kf.time));
          })),

          // Row 2: Track with line, edge bars, keyframe shapes, time indicator
          m('.capture-bar-track', {
            oncreate(vnode: m.VnodeDOM) { trackEl = vnode.dom as HTMLElement; },
            onupdate(vnode: m.VnodeDOM) { trackEl = vnode.dom as HTMLElement; },
            onclick: isDryRunning ? undefined : (e: MouseEvent) => {
              if (!trackEl) return;
              const time = xToTime(e.clientX, trackEl, start, end);
              km.add(time);
            },
          }, [
            // Horizontal line
            m('.capture-bar-line'),

            // Vertical edge bars
            m('.capture-bar-edge-bar.left'),
            m('.capture-bar-edge-bar.right'),

            // Time indicator
            m('.capture-bar-time-indicator', {
              style: { left: `${clampedTimePos}%` },
            }),

            // Keyframe markers
            ...keyframes.map(kf => {
              const pos = timeToPercent(kf.time, start, end);
              const isActive = kf.id === activeId;

              return m('.capture-bar-keyframe', {
                class: [
                  isActive ? 'active' : '',
                  kf.pinned ? 'pinned' : '',
                ].filter(Boolean).join(' '),
                style: { left: `${pos}%` },
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  km.toggle(kf.id);
                },
                onpointerdown: (e: PointerEvent) => {
                  e.stopPropagation();
                  e.preventDefault();
                  draggingId = kf.id;
                  dragStartY = e.clientY;
                  pendingDelete = false;
                  const markerEl = e.currentTarget as HTMLElement;

                  const onMove = (ev: PointerEvent) => {
                    if (draggingId === null || !trackEl) return;
                    const time = xToTime(ev.clientX, trackEl, start, end);
                    km.move(draggingId, time);
                    if (!kf.pinned) {
                      const dy = Math.abs(ev.clientY - dragStartY);
                      const shouldDelete = dy > DELETE_THRESHOLD;
                      if (shouldDelete !== pendingDelete) {
                        pendingDelete = shouldDelete;
                        markerEl.classList.toggle('deleting', pendingDelete);
                      }
                    }
                  };

                  const onUp = () => {
                    if (pendingDelete && draggingId !== null) {
                      km.deleteById(draggingId);
                    }
                    markerEl.classList.remove('deleting');
                    draggingId = null;
                    pendingDelete = false;
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                  };

                  document.addEventListener('pointermove', onMove);
                  document.addEventListener('pointerup', onUp);
                },
              });
            }),
          ]),

          // Row 3: Anim elapsed time labels (mapped to configured duration)
          m('.capture-bar-row.capture-bar-anim-times', keyframes.map(kf => {
            const pos = timeToPercent(kf.time, start, end);
            const fraction = (end - start) > 0 ? (kf.time - start) / (end - start) : 0;
            return m('span.capture-bar-time-label', {
              class: kf.id === activeId ? 'active' : '',
              style: { left: `${pos}%` },
            }, formatElapsedMMSS(fraction * animDurationMs));
          })),

        ]),
      ]);
    },
  };
};
