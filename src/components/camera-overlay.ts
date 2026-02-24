/**
 * CameraOverlay - Full-screen overlay with movable/resizable capture rect
 *
 * Rendered when camera mode !== 'off'. Blocks all globe interaction
 * via pointer-events: auto covering the viewport.
 *
 * Layout (top to bottom):
 *   Header  — format badge, label, record/stop/new, cog, close
 *   Palette — GIF mode only, 256-color stripe
 *   Rect    — capture area (dimensions, status, download)
 *   Input   — editable location label
 *
 * Any outer edge of the container is a resize hotspot.
 * Any inner surface (except input, buttons, edges) is a move handle.
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
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

/** Check if the event target is an interactive element (not a drag surface) */
function isInteractive(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'SELECT') return true;
  if (target.closest('button, input, a, select')) return true;
  if (target.classList.contains('edge')) return true;
  return false;
}

export const CameraOverlay: m.ClosureComponent<CameraOverlayAttrs> = () => {
  return {
    view({ attrs }) {
      const { captureService, dialogService, optionsService } = attrs;
      const mode = captureService.mode.value;
      const rect = captureService.rect.value;
      const palette = captureService.palette.value;
      const cameraOpts = optionsService.options.value.camera;
      const format = cameraOpts.format;
      const isGif = format === 'gif';
      const isCapturing = mode === 'capturing';
      const isProcessing = mode === 'processing';
      const isDone = mode === 'done';
      const isReady = mode === 'ready';
      const isBusy = isCapturing || isProcessing;
      const isLocked = isBusy || isDone;
      const borderColor = isBusy ? '#cc4444' : isDone ? '#000000' : '#44cc66';

      // Compute output dimensions for display
      const dpr = window.devicePixelRatio;
      const outW = cameraOpts.nativeDpr ? Math.round(rect.w * dpr) : rect.w;
      const outH = cameraOpts.nativeDpr ? Math.round(rect.h * dpr) : rect.h;

      return m('.camera-overlay', [
        m('.camera-container', {
          style: {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
          },
          // Move drag from any inner surface (except interactive elements)
          onpointerdown: isLocked ? undefined : (e: PointerEvent) => {
            if (!isInteractive(e.target)) {
              captureService.startMove(e);
            }
          },
        }, [
          // Resize edge hotspots on the container (hidden when locked)
          ...(!isLocked ? EDGES.map(edge =>
            m(`div.edge.edge-${edge}`, {
              onpointerdown: (e: PointerEvent) => captureService.startResize(e, edge),
            })
          ) : []),

          // Header bar
          m('.camera-header', [
            m('span.camera-label', `${format.toUpperCase()} Camera`),
            isDone
              ? m('button.btn.btn-primary.camera-record', {
                  onclick: () => {
                    captureService.mode.value = 'ready';
                    captureService.frameIndex.value = 0;
                    m.redraw();
                  },
                }, 'New')
              : isCapturing
                ? m('button.btn.btn-danger.camera-record', {
                    onclick: () => captureService.stop(),
                  }, 'Stop')
                : m('button.btn.btn-primary.camera-record', {
                    onclick: () => captureService.record(),
                    disabled: isProcessing || (!captureService.isQueueIdle ||
                      (isGif && cameraOpts.paletteMode !== 'grayscale' && !palette)),
                  }, 'Record'),
            m('button.camera-settings-btn', {
              onclick: () => dialogService.open('options', { filter: 'camera' }),
              disabled: isLocked,
            }, m(GearIcon)),
            m('button.camera-close', {
              onclick: () => captureService.exit(),
            }, '\u2715'),
          ]),

          // Palette stripe (GIF mode only, hidden in done mode)
          isGif && palette && !isDone ? m('.camera-palette-stripe',
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

          // Capture rect — grows in done mode to fit decorated preview
          m('.camera-rect', {
            style: {
              height: isDone
                ? `${rect.h + 32 + (cameraOpts.label && captureService.locationLabel.value ? 24 : 0)}px`
                : `${rect.h}px`,
              borderColor,
              cursor: isLocked ? 'default' : 'move',
            },
            class: isBusy ? 'recording' : '',
          }, [
            // Dimensions display (ready mode)
            isReady ? m('span.camera-dimensions', `${outW} \u00d7 ${outH}`) : null,

            // Waiting label (ready mode, below dimensions)
            isReady && (!captureService.isQueueIdle || (isGif && cameraOpts.paletteMode !== 'grayscale' && !palette))
              ? m('span.camera-waiting', [
                  'Waiting for ',
                  [
                    !captureService.isQueueIdle ? 'Queue' : null,
                    isGif && cameraOpts.paletteMode !== 'grayscale' && !palette ? 'Palette' : null,
                  ].filter(Boolean).join(', '),
                  '\u2026',
                ].flat())
              : null,

            // Status label (capturing / processing)
            isBusy ? m('span.camera-status',
              `${isCapturing ? 'Capturing' : 'Processing'} ${captureService.frameIndex.value}/${captureService.totalFrames.value}`
            ) : null,

            // Preview (done mode) — autoplay loop
            isDone && captureService.downloadUrl ? (
              isGif
                ? m('img.camera-preview', {
                    src: captureService.downloadUrl,
                  })
                : m('video.camera-preview', {
                    src: captureService.downloadUrl,
                    autoplay: true,
                    loop: true,
                    muted: true,
                    playsinline: true,
                  })
            ) : null,

            // Done overlay: filename label + action buttons
            isDone ? m('.camera-done-overlay', [
              m('span.camera-done-filename',
                `${captureService.downloadName} (${captureService.downloadSize})`),
              m('.camera-done-actions', [
                captureService.canShare
                  ? m('button.btn.btn-primary', {
                      onclick: () => captureService.share(),
                    }, 'Share')
                  : null,
                m('a.btn.btn-primary', {
                  href: captureService.downloadUrl,
                  download: captureService.downloadName,
                }, 'Save'),
              ]),
            ]) : null,
          ]),

          // Location input (disabled when locked)
          cameraOpts.label ? m('.camera-location-row',
            m('input.camera-location-input', {
              type: 'text',
              placeholder: 'Location\u2026',
              value: captureService.locationLabel.value,
              disabled: isLocked,
              oninput: (e: InputEvent) => {
                captureService.locationLabel.value = (e.target as HTMLInputElement).value;
              },
            })
          ) : null,
        ]),
      ]);
    },
  };
};
