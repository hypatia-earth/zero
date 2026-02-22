/**
 * CameraOverlay - Full-screen overlay with movable/resizable capture rect
 *
 * Rendered when camera mode !== 'off'. Blocks all globe interaction
 * via pointer-events: auto covering the viewport.
 */

import m from 'mithril';
import type { CameraService } from '../services/camera-service';
import type { DialogService } from '../services/dialog-service';

interface CameraOverlayAttrs {
  cameraService: CameraService;
  dialogService: DialogService;
}

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

/** Draw 256-color palette swatches on a canvas */
function drawPaletteStripe(canvas: HTMLCanvasElement, palette: number[][]): void {
  const ctx = canvas.getContext('2d')!;
  const w = palette.length;
  const h = canvas.height;
  canvas.width = w;
  for (let i = 0; i < w; i++) {
    const [r, g, b] = palette[i]!;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i, 0, 1, h);
  }
}

export const CameraOverlay: m.ClosureComponent<CameraOverlayAttrs> = () => {
  return {
    view({ attrs }) {
      const { cameraService, dialogService } = attrs;
      const mode = cameraService.mode.value;
      const rect = cameraService.rect.value;
      const palette = cameraService.palette.value;
      const isRecording = mode === 'recording';
      const isDone = mode === 'done';
      const isLocked = isRecording || isDone;
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
            isDone
              ? m('button.camera-record', {
                  style: { borderColor },
                  onclick: () => {
                    cameraService.mode.value = 'ready';
                    cameraService.frameIndex.value = 0;
                    m.redraw();
                  },
                }, 'New')
              : m('button.camera-record', {
                  style: { borderColor },
                  onclick: () => isRecording ? cameraService.stop() : cameraService.record(),
                  disabled: !isRecording && (!cameraService.isQueueIdle ||
                    (cameraService.paletteMode === 'scene' && !palette)),
                }, isRecording ? 'Stop' : 'Record'),
            m('button.camera-settings-btn', {
              onclick: () => dialogService.open('options', { filter: 'camera' }),
              disabled: isLocked,
            }, '\u2699'),
            m('button.camera-close', {
              onclick: () => cameraService.exit(),
            }, '\u2715'),
          ]),

          // Capture rect
          m('.camera-rect', {
            style: {
              height: `${rect.h}px`,
              borderColor,
              cursor: isLocked ? 'default' : 'move',
            },
            class: isRecording ? 'recording' : '',
            onpointerdown: isLocked ? undefined : (e: PointerEvent) => {
              if ((e.target as HTMLElement).classList.contains('camera-rect')) {
                cameraService.startMove(e);
              }
            },
          }, [
            // Resize edge hotspots (hidden during recording/done)
            ...(!isLocked ? EDGES.map(edge =>
              m(`div.edge.edge-${edge}`, {
                onpointerdown: (e: PointerEvent) => cameraService.startResize(e, edge),
              })
            ) : []),

            // Download link (shown in done mode)
            isDone ? m('a.camera-download', {
              href: cameraService.downloadUrl,
              download: cameraService.downloadName,
            }, 'Download GIF') : null,
          ]),

          // Palette stripe (shown when palette extracted, hidden in done mode)
          palette && !isDone ? m('.camera-palette-stripe',
            m('canvas', {
              height: 16,
              oncreate(vnode: m.VnodeDOM) {
                drawPaletteStripe(vnode.dom as HTMLCanvasElement, palette);
              },
              onupdate(vnode: m.VnodeDOM) {
                drawPaletteStripe(vnode.dom as HTMLCanvasElement, palette);
              },
            })
          ) : null,
        ]),
      ]);
    },
  };
};
