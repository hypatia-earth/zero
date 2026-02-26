/**
 * CaptureBar - Timeline track for animated capture mode
 *
 * Shows keyframe markers on a horizontal time track.
 * Handles keyframe creation, selection, dragging, and deletion.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import type { StateService } from '../services/state-service';
import { formatTimeHHMM, timeToPercent } from '../services/capture/helpers';

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

export const CaptureBar: m.ClosureComponent<CaptureBarAttrs> = () => {
  let trackEl: HTMLElement | null = null;
  let draggingId: number | null = null;

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
      const activeKf = activeId !== null ? keyframes.find(k => k.id === activeId) : null;

      // Current time indicator position
      const currentTime = stateService.viewState.value.time.getTime();
      const clampedTimePos = timeToPercent(currentTime, start, end);

      const isDryRunning = animated.dryRunning.value;
      const mode = captureService.mode.value;
      const canDryRun = mode === 'ready' && keyframes.length >= 2 && !isDryRunning;

      return m('.capture-bar', [
        // Buttons row
        m('.capture-bar-buttons', [
          isDryRunning
            ? m('button.capture-bar-btn.danger', {
                onclick: () => animated.abortDryRun(),
                title: 'Stop preview',
              }, '\u25A0 Abort')
            : m('button.capture-bar-btn', {
                disabled: !canDryRun,
                onclick: () => animated.dryRun(),
                title: 'Preview animation',
              }, '\u25B6 Dry Run'),
          !isDryRunning && activeKf && !activeKf.pinned
            ? m('button.capture-bar-btn.danger', {
                onclick: () => km.deleteActive(),
                title: 'Delete active keyframe',
              }, '\u2715 Delete')
            : null,
          isDryRunning
            ? m('span.capture-bar-progress',
                `${captureService.frameIndex.value}/${Number(captureService.totalFrames.value)}`)
            : null,
        ]),

        // Track
        m('.capture-bar-track', {
          oncreate(vnode: m.VnodeDOM) { trackEl = vnode.dom as HTMLElement; },
          onupdate(vnode: m.VnodeDOM) { trackEl = vnode.dom as HTMLElement; },
          onclick: isDryRunning ? undefined : (e: MouseEvent) => {
            if (!trackEl) return;
            const time = xToTime(e.clientX, trackEl, start, end);
            km.add(time);
          },
        }, [
          // Data window edge labels
          m('span.capture-bar-edge-label.left', formatTimeHHMM(start)),
          m('span.capture-bar-edge-label.right', formatTimeHHMM(end)),

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

                const onMove = (ev: PointerEvent) => {
                  if (draggingId === null || !trackEl) return;
                  const time = xToTime(ev.clientX, trackEl, start, end);
                  km.move(draggingId, time);
                };

                const onUp = () => {
                  draggingId = null;
                  document.removeEventListener('pointermove', onMove);
                  document.removeEventListener('pointerup', onUp);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
              },
            }, m('span.capture-bar-kf-label', formatTimeHHMM(kf.time)));
          }),
        ]),
      ]);
    },
  };
};
