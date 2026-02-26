/**
 * CaptureOverlay - Full-screen overlay with movable/resizable capture rect
 *
 * Rendered when capture mode !== 'off'. Blocks all globe interaction
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
import { snapEven } from '../services/capture/helpers';
import type { CaptureService } from '../services/capture/capture-service';
import type { DialogService } from '../services/dialog-service';
import type { OptionsService } from '../services/options-service';

interface CaptureOverlayAttrs {
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

export const CaptureOverlay: m.ClosureComponent<CaptureOverlayAttrs> = () => {
  let pointerUpHandler: ((e: PointerEvent) => void) | null = null;

  return {
    oncreate({ attrs }) {
      // In animated mode, update active keyframe camera on pointerup (after drag)
      pointerUpHandler = (_e: PointerEvent) => {
        if (attrs.captureService.animated.captureType.value === 'animated' &&
            attrs.captureService.km.activeKeyframeId.value !== null) {
          attrs.captureService.km.updateActiveCamera();
        }
      };
      document.addEventListener('pointerup', pointerUpHandler);
    },

    onremove() {
      if (pointerUpHandler) {
        document.removeEventListener('pointerup', pointerUpHandler);
        pointerUpHandler = null;
      }
    },

    view({ attrs }) {
      const { captureService, dialogService, optionsService } = attrs;
      const mode = captureService.mode.value;
      const rect = captureService.rect.value;
      const palette = captureService.palette.value;
      const captureOpts = optionsService.options.value.capture;
      const format = captureOpts.format;
      const isGif = format === 'gif';
      const isCapturing = mode === 'capturing';
      const isProcessing = mode === 'processing';
      const isDone = mode === 'done';
      const isReady = mode === 'ready';
      const isBusy = isCapturing || isProcessing;
      const isLocked = isBusy || isDone;
      const isAnimated = captureService.animated.captureType.value === 'animated';
      const borderColor = isBusy ? '#cc4444' : isDone ? '#000000' : '#44cc66';

      // Compute output dimensions for display
      const dpr = window.devicePixelRatio;
      const border = 2;  // CSS px, matches .capture-rect border width
      const contentW = rect.w - border * 2;
      const contentH = rect.h - border * 2;
      const outW = captureOpts.nativeDpr ? snapEven(Math.round(contentW * dpr)) : contentW;
      const outH = captureOpts.nativeDpr ? snapEven(Math.round(contentH * dpr)) : contentH;

      // In animated mode: overlay background is pointer-events:none so canvas receives events.
      // Header, rect border, and capture-container get pointer-events:auto explicitly.
      return m('.capture-overlay', {
        style: isAnimated ? { pointerEvents: 'none' } : undefined,
      }, [
        m('.capture-container', {
          style: {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
            ...(isAnimated ? { pointerEvents: 'auto' } : {}),
          },
          // Move drag from any inner surface (except interactive elements)
          onpointerdown: isLocked ? undefined : (e: PointerEvent) => {
            if (!isInteractive(e.target)) {
              captureService.startMove(e);
            }
          },
        }, [
          // Header bar
          m('.capture-header', [
            m('span.capture-label', `${format.toUpperCase()} Capture`),
            // Toggle simple/animated button (ready mode only)
            isReady ? m('button.capture-type-toggle', {
              onclick: () => captureService.toggleCaptureType(),
              title: isAnimated ? 'Switch to simple capture' : 'Switch to animated capture',
            }, isAnimated ? '\u25B6' : '\u23F1') : null,
            // Dry run / abort (animated mode only)
            isAnimated && captureService.animated.dryRunning.value
              ? m('button.btn.btn-danger.capture-record', {
                  onclick: () => captureService.animated.abortDryRun(),
                  title: 'Stop preview',
                }, 'Abort')
              : isAnimated && isReady && captureService.km.keyframes.value.length >= 2
                ? m('button.btn.btn-primary.capture-record', {
                    onclick: () => captureService.animated.dryRun(),
                    title: 'Preview animation',
                  }, 'Preview')
                : null,
            isDone
              ? m('button.btn.btn-primary.capture-record', {
                  onclick: () => {
                    captureService.mode.value = 'ready';
                    captureService.frameIndex.value = 0;
                    m.redraw();
                  },
                }, 'New')
              : isBusy
                ? m('button.btn.btn-danger.capture-record', {
                    onclick: () => captureService.stop(),
                  }, 'Stop')
                : m('button.btn.btn-primary.capture-record', {
                    onclick: () => captureService.record(),
                    disabled: !captureService.isQueueIdle ||
                      (!isAnimated && isGif && captureOpts.paletteMode !== 'grayscale' && !palette),
                  }, 'Record'),
            m('button.capture-settings-btn', {
              onclick: () => dialogService.open('options', { filter: 'capture' }),
              disabled: isLocked,
            }, m(GearIcon)),
            m('button.capture-close', {
              onclick: () => captureService.exit(),
            }, '\u2715'),
          ]),

          // Palette stripe (GIF mode only, hidden in done mode and animated mode)
          isGif && palette && !isDone && !isAnimated ? m('.capture-palette-stripe',
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

          // Capture rect
          m('.capture-rect', {
            style: { height: `${rect.h}px` },
          }, [
            // Border (visual only, no pointer events)
            m('.capture-border', { style: { borderColor } }),

            // Resize edge hotspots (hidden when locked)
            ...(!isLocked ? EDGES.map(edge =>
              m(`div.edge.edge-${edge}`, {
                onpointerdown: (e: PointerEvent) => captureService.startResize(e, edge),
              })
            ) : []),

            // Content area (move handle, pointer-events:none in animated for canvas passthrough)
            m('.capture-content', {
              style: {
                cursor: isLocked ? 'default' : undefined,
                ...(isAnimated && !isLocked && !isDone ? { pointerEvents: 'none' } : {}),
              },
            }, [
              // Dimensions display (ready mode)
              isReady ? m('span.capture-dimensions', `${outW} \u00d7 ${outH}`) : null,

              // Animated info (ready mode, below dimensions)
              isReady && isAnimated ? (
                captureService.km.dataWindowEnd > 0
                  ? (() => {
                      const info = captureService.animated.getAnimInfo();
                      return m('.capture-anim-info', [
                        m('span', info.startLabel),
                        m('span', info.smpte),
                        m('span', info.frameLabel),
                      ]);
                    })()
                  : m('span.capture-waiting', 'Waiting for Queue\u2026')
              ) : null,

              // Waiting label (ready mode, below dimensions)
              isReady && !isAnimated && (!captureService.isQueueIdle || (isGif && captureOpts.paletteMode !== 'grayscale' && !palette))
                ? m('span.capture-waiting', [
                    'Waiting for ',
                    [
                      !captureService.isQueueIdle ? 'Queue' : null,
                      isGif && captureOpts.paletteMode !== 'grayscale' && !palette ? 'Palette' : null,
                    ].filter(Boolean).join(', '),
                    '\u2026',
                  ].flat())
                : null,

              // Status label (capturing / processing)
              isBusy ? m('span.capture-status',
                `${isCapturing ? 'Capturing' : 'Processing'} ${captureService.frameIndex.value}/${captureService.totalFrames.value}`
              ) : null,

              // Preview (done mode) — autoplay loop
              isDone && captureService.downloadUrl ? (
                isGif
                  ? m('img.capture-preview', {
                      src: captureService.downloadUrl,
                    })
                  : m('video.capture-preview', {
                      src: captureService.downloadUrl,
                      autoplay: true,
                      loop: true,
                      muted: true,
                      playsinline: true,
                    })
              ) : null,

              // Done overlay: filename label + action buttons
              isDone ? m('.capture-done-overlay', [
                m('span.capture-done-filename',
                  `${captureService.downloadName} (${captureService.downloadSize})`),
                m('.capture-done-actions', [
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
          ]),

          // Location input (disabled when locked)
          captureOpts.label ? m('.capture-location-row',
            m('input.capture-location-input', {
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
