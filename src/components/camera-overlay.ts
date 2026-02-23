/**
 * CameraOverlay - Full-screen overlay with movable/resizable capture rect
 *
 * Rendered when camera mode !== 'off'. Blocks all globe interaction
 * via pointer-events: auto covering the viewport.
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';
import type { DialogService } from '../services/dialog-service';
import type { OptionsService } from '../services/options-service';

interface CameraOverlayAttrs {
  captureService: CaptureService;
  dialogService: DialogService;
  optionsService: OptionsService;
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
      const { captureService, dialogService, optionsService } = attrs;
      const mode = captureService.mode.value;
      const rect = captureService.rect.value;
      const palette = captureService.palette.value;
      const isCapturing = mode === 'capturing';
      const isProcessing = mode === 'processing';
      const isDone = mode === 'done';
      const isBusy = isCapturing || isProcessing;
      const isLocked = isBusy || isDone;
      const borderColor = isBusy ? '#cc4444' : '#44cc66';

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
            isDone
              ? m('button.camera-record', {
                  style: { borderColor },
                  onclick: () => {
                    captureService.mode.value = 'ready';
                    captureService.frameIndex.value = 0;
                    m.redraw();
                  },
                }, 'New')
              : m('button.camera-record', {
                  style: { borderColor },
                  onclick: () => isCapturing ? captureService.stop() : captureService.record(),
                  disabled: isProcessing || (!isCapturing && (!captureService.isQueueIdle ||
                    (optionsService.options.value.camera.paletteMode !== 'grayscale' && !palette))),
                }, isCapturing ? 'Stop' : 'Record'),
            m('button.camera-settings-btn', {
              onclick: () => dialogService.open('options', { filter: 'camera' }),
              disabled: isLocked,
            }, '\u2699'),
            m('button.camera-close', {
              onclick: () => captureService.exit(),
            }, '\u2715'),
          ]),

          // Capture rect
          m('.camera-rect', {
            style: {
              height: `${rect.h}px`,
              borderColor,
              cursor: isLocked ? 'default' : 'move',
            },
            class: isBusy ? 'recording' : '',
            onpointerdown: isLocked ? undefined : (e: PointerEvent) => {
              if ((e.target as HTMLElement).classList.contains('camera-rect')) {
                captureService.startMove(e);
              }
            },
          }, [
            // Resize edge hotspots (hidden when locked)
            ...(!isLocked ? EDGES.map(edge =>
              m(`div.edge.edge-${edge}`, {
                onpointerdown: (e: PointerEvent) => captureService.startResize(e, edge),
              })
            ) : []),

            // Status label (capturing / processing)
            isBusy ? m('span.camera-status',
              `${isCapturing ? 'Capturing' : 'Processing'} ${captureService.frameIndex.value}/${captureService.totalFrames.value}`
            ) : null,

            // Download link (shown in done mode)
            isDone ? m('a.camera-download', {
              href: captureService.downloadUrl,
              download: captureService.downloadName,
            }, `Download ${optionsService.options.value.camera.format.toUpperCase()}`) : null,
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
