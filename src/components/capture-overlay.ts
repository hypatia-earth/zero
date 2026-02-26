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

/** Truncate a filename in the middle, preserving start and extension */
function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  const keep = max - ext.length - 1; // 1 for ellipsis char
  const head = name.slice(0, Math.ceil(keep / 2));
  const tail = name.slice(name.length - ext.length - Math.floor(keep / 2), name.length - ext.length);
  return head + '\u2026' + tail + ext;
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
            // Flight plan button (animated mode only)
            isAnimated ? m('button.capture-flight-plan-btn', {
              onclick: () => dialogService.open('flight-plan'),
              disabled: isBusy,
              title: 'Flight Plan',
            }, '\u2708') : null,
            // Dry run / abort (animated mode only)
            isAnimated && captureService.animated.dryRunning.value
              ? m('button.btn.btn-danger.capture-record', {
                  onclick: () => captureService.animated.abortDryRun(),
                  title: 'Stop preview',
                }, 'Abort')
              : isAnimated && (isReady || isBusy) && captureService.km.keyframes.value.length >= 2
                ? m('button.btn.btn-primary.capture-record', {
                    onclick: () => captureService.animated.dryRun(),
                    disabled: isBusy,
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
                  }, 'Abort')
                : m('button.btn.btn-primary.capture-record', {
                    onclick: () => captureService.record(),
                    disabled: captureService.animated.dryRunning.value ||
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
              // During recording: only status
              isBusy ? m('span.capture-status',
                `Capturing ${captureService.frameIndex.value}/${captureService.totalFrames.value}`
              ) : null,

              // Dimensions display (ready mode / dry run)
              !isBusy && !isDone ? m('.capture-dimensions', [
                m('span.dim-value.dim-left', `${outW}`),
                m('span.dim-sep', '\u00d7'),
                m('span.dim-value.dim-right', `${outH}`),
              ]) : null,

              // Animated info (ready / dry run)
              !isBusy && !isDone && isAnimated && captureService.km.dataWindowEnd > 0
                ? (() => {
                    const info = captureService.animated.getAnimInfo();
                    return m('.capture-anim-info', [
                      m('span', info.timeLabel),
                      m('span', info.smpte),
                      m('span', info.frameLabel),
                    ]);
                  })()
                : null,

              // Waiting label (ready mode, palette extraction in progress)
              isReady && !isAnimated && isGif && captureOpts.paletteMode !== 'grayscale' && !palette
                ? m('span.capture-waiting', 'Waiting for Palette\u2026')
                : null,

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
                  `${middleTruncate(captureService.downloadName, 36)} (${captureService.downloadSize})`),
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
                captureService.setLocationLabel((e.target as HTMLInputElement).value);
              },
            })
          ) : null,
        ]),
      ]);
    },
  };
};
