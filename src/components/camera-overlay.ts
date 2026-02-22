/**
 * CameraOverlay - Full-screen overlay with movable/resizable capture rect
 *
 * Rendered when camera mode !== 'off'. Blocks all globe interaction
 * via pointer-events: auto covering the viewport.
 */

import m from 'mithril';
import type { CameraService } from '../services/camera-service';

interface CameraOverlayAttrs {
  cameraService: CameraService;
}

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

export const CameraOverlay: m.ClosureComponent<CameraOverlayAttrs> = () => {
  return {
    view({ attrs }) {
      const { cameraService } = attrs;
      const mode = cameraService.mode.value;
      const rect = cameraService.rect.value;
      const isRecording = mode === 'recording';
      const borderColor = isRecording ? '#cc4444' : '#44cc66';

      return m('.camera-overlay', [
        m('.camera-container', {
          style: {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
          },
        }, [
          // Header bar
          m('.camera-header', [
            m('span.camera-label', 'Camera'),
            m('span.camera-frames', `${cameraService.frameIndex.value}/${cameraService.totalFrames.value}`),
            m('select.camera-duration', {
              value: String(cameraService.duration.value),
              onchange: (e: Event) => {
                cameraService.duration.value = Number((e.target as HTMLSelectElement).value);
              },
              disabled: isRecording,
            }, cameraService.durations.map(d =>
              m('option', { value: String(d) }, `${d}s`)
            )),
            m('button.camera-record', {
              style: { borderColor },
              onclick: () => isRecording ? cameraService.stop() : cameraService.record(),
              disabled: !isRecording && !cameraService.isQueueIdle,
            }, isRecording ? 'Stop' : 'Record'),
            m('button.camera-close', {
              onclick: () => cameraService.exit(),
            }, '\u2715'),
          ]),

          // Capture rect
          m('.camera-rect', {
            style: {
              height: `${rect.h}px`,
              borderColor,
              cursor: isRecording ? 'default' : 'move',
            },
            class: isRecording ? 'recording' : '',
            onpointerdown: isRecording ? undefined : (e: PointerEvent) => {
              if ((e.target as HTMLElement).classList.contains('camera-rect')) {
                cameraService.startMove(e);
              }
            },
          }, [
            // Resize edge hotspots (hidden during recording)
            ...(!isRecording ? EDGES.map(edge =>
              m(`div.edge.edge-${edge}`, {
                onpointerdown: (e: PointerEvent) => cameraService.startResize(e, edge),
              })
            ) : []),
          ]),
        ]),
      ]);
    },
  };
};
