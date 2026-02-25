/**
 * CaptureBar - Timeline track for animated capture mode
 *
 * Shows keyframe markers on a horizontal time track.
 * Handles keyframe creation, selection, dragging, and deletion.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import type { StateService } from '../services/state-service';

interface CaptureBarAttrs {
  captureService: CaptureService;
  stateService: StateService;
}

/** Format time as HH:MM UTC */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
      const isAnimated = captureService.captureType.value === 'animated';
      if (!isAnimated) return null;

      const keyframes = captureService.keyframes.value;
      const activeId = captureService.activeKeyframeId.value;
      const start = captureService.dataWindowStart;
      const end = captureService.dataWindowEnd;
      const range = end - start;
      const activeKf = activeId !== null ? keyframes.find(k => k.id === activeId) : null;

      // Current time indicator position
      const currentTime = stateService.viewState.value.time.getTime();
      const timePos = range > 0 ? ((currentTime - start) / range) * 100 : 0;
      const clampedTimePos = Math.max(0, Math.min(100, timePos));

      const isDryRunning = captureService.dryRunning.value;
      const mode = captureService.mode.value;
      const canDryRun = mode === 'ready' && keyframes.length >= 2 && !isDryRunning;

      return m('.capture-bar', [
        // Buttons row
        m('.capture-bar-buttons', [
          isDryRunning
            ? m('button.capture-bar-btn.danger', {
                onclick: () => captureService.abortDryRun(),
                title: 'Stop preview',
              }, '\u25A0 Abort')
            : m('button.capture-bar-btn', {
                disabled: !canDryRun,
                onclick: () => captureService.dryRun(),
                title: 'Preview animation',
              }, '\u25B6 Dry Run'),
          !isDryRunning && activeKf && !activeKf.pinned
            ? m('button.capture-bar-btn.danger', {
                onclick: () => captureService.deleteActiveKeyframe(),
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
            // Only on empty track area — keyframe clicks stopPropagation
            if (!trackEl) return;
            const time = xToTime(e.clientX, trackEl, start, end);
            captureService.addKeyframe(time);
          },
        }, [
          // Time indicator
          m('.capture-bar-time-indicator', {
            style: { left: `${clampedTimePos}%` },
          }),

          // Keyframe markers
          ...keyframes.map(kf => {
            const pos = range > 0 ? ((kf.time - start) / range) * 100 : 0;
            const isActive = kf.id === activeId;

            return m('.capture-bar-keyframe', {
              class: [
                isActive ? 'active' : '',
                kf.pinned ? 'pinned' : '',
              ].filter(Boolean).join(' '),
              style: { left: `${pos}%` },
              title: fmtTime(kf.time),
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                captureService.toggleKeyframe(kf.id);
              },
              onpointerdown: (e: PointerEvent) => {
                e.stopPropagation();
                e.preventDefault();
                draggingId = kf.id;

                const onMove = (ev: PointerEvent) => {
                  if (draggingId === null || !trackEl) return;
                  const time = xToTime(ev.clientX, trackEl, start, end);
                  captureService.moveKeyframe(draggingId, time);
                };

                const onUp = () => {
                  draggingId = null;
                  document.removeEventListener('pointermove', onMove);
                  document.removeEventListener('pointerup', onUp);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
              },
            });
          }),
        ]),
      ]);
    },
  };
};
