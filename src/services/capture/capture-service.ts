/**
 * CaptureService - Capture mode state machine
 *
 * Manages capture overlay state: mode transitions, rect position/size,
 * drag/resize interactions, and duration/frame tracking.
 *
 * Modes: off → ready → capturing → processing → done → ready → off
 */

import m from 'mithril';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals-core';
import { extractPalette, createGifSession } from './gif';
import { createMp4Session } from './mp4';
import { reverseGeocode } from './location';
import { loadLogo, createDecorator } from './decorate';
import type { AuroraService } from '../aurora-service';
import type { StateService } from '../state-service';
import type { OptionsService } from '../options-service';
import type { QueueStats } from '../../config/types';

const RECT_BORDER = 2;
const RECT_DEFAULT_SIZE = 480;
const RECT_MIN_WIDTH = 320 + RECT_BORDER * 2;
const RECT_MIN_HEIGHT = 240 + RECT_BORDER * 2;

const ASPECT_RATIOS: Record<string, number | null> = {
  'free': null,
  '16:9': 16 / 9,
  '4:5': 4 / 5,
  '1:1': 1,
  '9:16': 9 / 16,
};

/**
 * Resolve initial rect from saved lastRect with fallback chain:
 * 1. Saved rect as-is (if valid size and fits viewport)
 * 2. Saved rect re-centered (if valid size but outside viewport)
 * 3. Default rect matching current aspect ratio option
 */
function resolveInitialRect(
  saved: { x: number; y: number; w: number; h: number } | null,
  ratio: number | null,
  minY: number,
): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Check if saved rect has valid dimensions
  if (saved && saved.w >= RECT_MIN_WIDTH && saved.h >= RECT_MIN_HEIGHT) {
    // Try as-is
    if (saved.x >= 0 && saved.y >= minY && saved.x + saved.w <= vw && saved.y + saved.h <= vh) {
      return { ...saved };
    }
    // Re-center with saved dimensions
    const x = Math.round((vw - saved.w) / 2);
    const y = Math.round((vh - saved.h) / 2);
    if (x >= 0 && y >= minY && x + saved.w <= vw && y + saved.h <= vh) {
      return { x, y, w: saved.w, h: saved.h };
    }
  }

  // Default rect matching aspect ratio
  let w = RECT_DEFAULT_SIZE;
  let h: number;
  if (ratio !== null) {
    h = Math.round((w - RECT_BORDER * 2) / ratio) + RECT_BORDER * 2;
    // If too tall for viewport, derive from height instead
    if (h > vh - minY) {
      h = Math.round((vh - minY) * 0.75);
      w = Math.round((h - RECT_BORDER * 2) * ratio) + RECT_BORDER * 2;
    }
  } else {
    h = Math.round(w * 0.75);
  }
  const x = Math.round((vw - w) / 2);
  const y = Math.round((vh - h) / 2);
  return { x, y, w, h };
}

type CaptureMode = 'off' | 'ready' | 'capturing' | 'processing' | 'done';
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CaptureService {
  readonly mode: Signal<CaptureMode> = signal('off');
  readonly rect: Signal<Rect>;
  readonly frameIndex: Signal<number> = signal(0);
  readonly totalFrames: ReadonlySignal<number>;
  readonly palette: Signal<number[][] | null> = signal(null);
  readonly locationLabel: Signal<string> = signal('');

  private readonly optionsService: OptionsService;
  private readonly stateService: StateService;
  private readonly auroraService: AuroraService;
  private readonly queueStats: Signal<QueueStats>;
  private paletteCanvas: OffscreenCanvas | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private captureDebounce: ReturnType<typeof setTimeout> | null = null;
  private locationDebounce: ReturnType<typeof setTimeout> | null = null;
  private geocodeAvailable = true;
  downloadUrl: string | null = null;
  downloadName = 'zero.hypatia';
  downloadSize = '';
  private downloadBlob: Blob | null = null;
  private aborted = false;

  constructor(
    optionsService: OptionsService,
    stateService: StateService,
    queueStats: Signal<QueueStats>,
    auroraService: AuroraService,
  ) {
    this.optionsService = optionsService;
    this.stateService = stateService;
    this.queueStats = queueStats;
    this.auroraService = auroraService;
    auroraService.onExportFrame = (bitmap: ImageBitmap) => this.onPreviewFrame(bitmap);

    const saved = optionsService.options.value.capture.lastRect;
    const ratio = ASPECT_RATIOS[optionsService.options.value.capture.aspectRatio] ?? null;
    this.rect = signal(resolveInitialRect(saved, ratio, 0));
    this.totalFrames = computed(() => {
      const { duration, fps } = this.options;
      return Number(duration) * Number(fps);
    });
  }

  private get options() {
    return this.optionsService.options.value.capture;
  }

  get isQueueIdle(): boolean {
    return this.queueStats.value.itemsQueued === 0;
  }

  // ── Mode transitions ──────────────────────────────────────────────

  enter(): void {
    if (this.mode.value !== 'off') return;
    this.mode.value = 'ready';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.installEscapeHandler();
    this.requestCaptureFrame();
    m.redraw();
    // Delay so .capture-rect DOM exists after redraw
    requestAnimationFrame(() => this.requestLocationUpdate(0));
  }

  record(): void {
    if (this.mode.value !== 'ready') return;
    if (!this.isQueueIdle) return;
    if (this.options.format === 'gif' && this.options.paletteMode !== 'grayscale' && !this.palette.value) return;
    // Cancel pending preview capture to prevent stale exportFrame during capturing
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    // Persist rect for next session
    this.optionsService.update(d => { d.capture.lastRect = { ...this.rect.value }; });
    this.mode.value = 'capturing';
    this.frameIndex.value = 0;
    this.aborted = false;
    this.runRecordingLoop();
    m.redraw();
  }

  stop(): void {
    if (this.mode.value !== 'capturing' && this.mode.value !== 'processing') return;
    this.aborted = true;
    // Mode transition happens when loop detects abort
  }

  exit(): void {
    if (this.mode.value === 'off') return;
    if (this.mode.value === 'capturing' || this.mode.value === 'processing') this.aborted = true;
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    if (this.locationDebounce) { clearTimeout(this.locationDebounce); this.locationDebounce = null; }
    this.mode.value = 'off';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.locationLabel.value = '';
    this.geocodeAvailable = true;
    this.revokeDownloadUrl();
    this.auroraService.recording = false;
    this.removeEscapeHandler();
    m.redraw();
  }

  get canShare(): boolean {
    if (!this.downloadBlob || !navigator.canShare) return false;
    const file = new File([this.downloadBlob], this.downloadName, { type: this.downloadBlob.type });
    return navigator.canShare({ files: [file] });
  }

  async share(): Promise<void> {
    if (!this.downloadBlob) return;
    const file = new File([this.downloadBlob], this.downloadName, { type: this.downloadBlob.type });
    await navigator.share({ files: [file] });
  }

  private buildFilename(timeMs: number): string {
    const d = new Date(timeMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dt = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}UTC`;
    const loc = this.locationLabel.value.trim().replace(/[<>:"/\\|?*]+/g, '');
    const ext = this.options.format;
    return loc
      ? `zero.hypatia-${dt}-${loc}.${ext}`
      : `zero.hypatia-${dt}.${ext}`;
  }

  private revokeDownloadUrl(): void {
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
    this.downloadBlob = null;
  }

  // ── Recording loop ───────────────────────────────────────────────

  private async runRecordingLoop(): Promise<void> {
    const aurora = this.auroraService;
    const { format, fps: fpsStr, paletteMode } = this.options;
    const fps = Number(fpsStr);
    const fixedDtMs = 1000 / fps;
    const totalFrames = this.totalFrames.value;
    const frozenTime = this.stateService.viewState.value.time.getTime();

    aurora.recording = true;

    try {
      // Worker renders all frames in a tight loop — no cross-thread round trips
      const bitmaps = await new Promise<ImageBitmap[]>(resolve => {
        aurora.onRecordProgress = (frameIndex) => {
          if (this.aborted) { resolve([]); return; }
          this.frameIndex.value = frameIndex;
          m.redraw();
        };
        aurora.onRecordBatchComplete = (batch) => resolve(batch);
        const camera = aurora.getCameraSnapshot();
        aurora.send({ type: 'recordBatch', camera, time: frozenTime, fixedDtMs, totalFrames });
      });

      // Abort during capturing — skip processing entirely
      if (this.aborted) {
        for (const bmp of bitmaps) bmp.close();
        this.mode.value = 'ready';
        return;
      }

      // Phase 2: processing (crop + encode)
      this.mode.value = 'processing';
      this.frameIndex.value = 0;
      m.redraw();

      const { w: outW, h: outH } = this.getOutputDimensions();

      // Build decorator for header/footer bars
      const label = this.options.label ? this.locationLabel.value : '';
      const d = new Date(frozenTime);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
      const logo = await loadLogo();
      const scale = outW / this.rect.value.w;
      const decorator = createDecorator(outW, outH, label, timestamp, logo, scale);

      const comment = `zero.hypatia.earth | ${timestamp}${label ? ` | ${label}` : ''}\nData: ECMWF IFS \u00b7 CC BY 4.0`;
      const session = format === 'mp4'
        ? createMp4Session(fps, outW, outH)
        : createGifSession(fps, paletteMode, this.palette.value, comment);

      for (let i = 0; i < bitmaps.length; i++) {
        if (this.aborted) {
          for (let j = i; j < bitmaps.length; j++) bitmaps[j]!.close();
          break;
        }
        const rgba = this.cropBitmap(bitmaps[i]!, outW, outH);
        const decorated = decorator.decorate(rgba);
        session.addFrame(decorated, outW, outH);
        this.frameIndex.value = i + 1;
        m.redraw();
        // Yield each frame to keep UI responsive during encoding
        await new Promise<void>(r => setTimeout(r, 0));
      }

      if (!this.aborted) {
        const blob = await session.finish();
        this.revokeDownloadUrl();
        this.downloadBlob = blob;
        this.downloadUrl = URL.createObjectURL(blob);
        this.downloadName = this.buildFilename(frozenTime);
        const mb = blob.size / (1024 * 1024);
        this.downloadSize = mb >= 1 ? `${mb.toFixed(1)}MB` : `${(blob.size / 1024).toFixed(0)}KB`;
        this.mode.value = 'done';
      } else {
        this.mode.value = 'ready';
      }
    } finally {
      aurora.recording = false;
      aurora.onRecordProgress = null;
      aurora.onRecordBatchComplete = null;
      m.redraw();
    }
  }

  private cropBitmap(bitmap: ImageBitmap, outW: number, outH: number): Uint8ClampedArray {
    const rect = this.rect.value;
    const dpr = window.devicePixelRatio;
    const border = 2;  // CSS px, matches .capture-rect border width
    let srcX = Math.round((rect.x + border) * dpr);
    let srcY = Math.round((rect.y + border) * dpr);
    let srcW = Math.round((rect.w - border * 2) * dpr);
    let srcH = Math.round((rect.h - border * 2) * dpr);

    // Clamp to bitmap bounds — shouldn't happen (rect is viewport-constrained),
    // but guards against stale bitmap after orientation change on iPad Safari
    srcX = Math.min(srcX, bitmap.width);
    srcY = Math.min(srcY, bitmap.height);
    srcW = Math.min(srcW, bitmap.width - srcX);
    srcH = Math.min(srcH, bitmap.height - srcY);

    if (!this.paletteCanvas || this.paletteCanvas.width !== outW || this.paletteCanvas.height !== outH) {
      this.paletteCanvas = new OffscreenCanvas(outW, outH);
    }

    const ctx = this.paletteCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    bitmap.close();
    return ctx.getImageData(0, 0, outW, outH).data;
  }

  private getOutputDimensions(): { w: number; h: number } {
    const rect = this.rect.value;
    const border = 2;  // CSS px, matches .capture-rect border width
    const contentW = rect.w - border * 2;
    const contentH = rect.h - border * 2;
    if (this.options.nativeDpr) {
      const dpr = window.devicePixelRatio;
      // Snap to even — H.264 requires even dimensions, GIF benefits too
      return { w: Math.round(contentW * dpr) & ~1, h: Math.round(contentH * dpr) & ~1 };
    }
    return { w: contentW, h: contentH };
  }

  // ── Frame capture & palette extraction ───────────────────────────

  requestCaptureFrame(): void {
    if (this.captureDebounce) clearTimeout(this.captureDebounce);
    this.captureDebounce = setTimeout(() => {
      this.captureDebounce = null;
      this.auroraService?.send({ type: 'captureFrame' });
    }, 150);
  }

  /** Debounced geocode from rect center. Immediate when delay=0 (e.g. on enter). */
  requestLocationUpdate(delay = 1000): void {
    if (!this.options.label || !this.geocodeAvailable) return;
    if (this.locationDebounce) clearTimeout(this.locationDebounce);
    this.locationLabel.value = '\u2026';
    m.redraw();
    this.locationDebounce = setTimeout(() => {
      this.locationDebounce = null;
      const el = document.querySelector('.capture-rect');
      if (!el) return;
      const bounds = el.getBoundingClientRect();
      const cam = this.auroraService.getCamera();
      const hit = cam.screenToGlobe(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
        window.innerWidth,
        window.innerHeight,
      );
      if (!hit) {
        this.locationLabel.value = 'Space';
        m.redraw();
        return;
      }
      reverseGeocode(hit.lat, hit.lon).then(label => {
        if (this.mode.value === 'off') return;
        if (!label) {
          this.geocodeAvailable = false;
          this.locationLabel.value = 'Your description here';
        } else {
          this.locationLabel.value = label;
        }
        m.redraw();
      });
    }, delay);
  }

  private paletteRetries = 0;

  private async onPreviewFrame(bitmap: ImageBitmap): Promise<void> {
    if (this.mode.value === 'off') return;
    const palette = await extractPalette(bitmap, this.rect.value, this.options.nativeDpr);
    // First frame may return black (GPU not ready) — retry up to 3 times
    if (palette.every(([r, g, b]) => r === 0 && g === 0 && b === 0) && this.paletteRetries < 3) {
      this.paletteRetries++;
      this.requestCaptureFrame();
      return;
    }
    this.paletteRetries = 0;
    this.palette.value = palette;
    m.redraw();
  }

  // ── Escape key ────────────────────────────────────────────────────

  private installEscapeHandler(): void {
    this.removeEscapeHandler();
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.mode.value !== 'off') {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
      }
    };
    window.addEventListener('keydown', this.escapeHandler, true);
  }

  private removeEscapeHandler(): void {
    if (this.escapeHandler) {
      window.removeEventListener('keydown', this.escapeHandler, true);
      this.escapeHandler = null;
    }
  }

  // ── Rect drag (move) ─────────────────────────────────────────────

  /** Measure header height from DOM so rect.y never pushes header offscreen */
  private getHeaderHeight(): number {
    const el = document.querySelector('.capture-header');
    return el ? el.getBoundingClientRect().height : 0;
  }

  private get isLocked(): boolean {
    const m = this.mode.value;
    return m === 'capturing' || m === 'processing' || m === 'done';
  }

  startMove(e: PointerEvent): void {
    if (this.isLocked) return;
    e.preventDefault();
    const r = this.rect.value;
    const startX = e.clientX - r.x;
    const startY = e.clientY - r.y;
    const minY = this.getHeaderHeight();

    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = Math.max(0, Math.min(vw - r.w, ev.clientX - startX));
      const y = Math.max(minY, Math.min(vh - r.h, ev.clientY - startY));
      this.rect.value = { ...this.rect.value, x, y };
      this.requestCaptureFrame();
      m.redraw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      this.requestLocationUpdate();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ── Rect resize ───────────────────────────────────────────────────

  startResize(e: PointerEvent, edge: Edge): void {
    if (this.isLocked) return;
    e.preventDefault();
    e.stopPropagation();
    const startRect = { ...this.rect.value };
    const startX = e.clientX;
    const startY = e.clientY;
    const minY = this.getHeaderHeight();

    const ratio = ASPECT_RATIOS[this.options.aspectRatio] ?? null;
    const isCardinal = edge.length === 1;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let { x, y, w, h } = startRect;

      // Horizontal edges
      if (edge.includes('e')) {
        w = Math.max(RECT_MIN_WIDTH, Math.min(vw - x, startRect.w + dx));
      }
      if (edge.includes('w')) {
        x = Math.max(0, Math.min(startRect.x + dx, startRect.x + startRect.w - RECT_MIN_WIDTH));
        w = startRect.x + startRect.w - x;
      }

      // Vertical edges
      if (edge.includes('s')) {
        h = Math.max(RECT_MIN_HEIGHT, Math.min(vh - y, startRect.h + dy));
      }
      if (edge === 'n' || edge === 'ne' || edge === 'nw') {
        y = Math.max(minY, Math.min(startRect.y + dy, startRect.y + startRect.h - RECT_MIN_HEIGHT));
        h = startRect.y + startRect.h - y;
      }

      // Aspect ratio enforcement
      if (ratio !== null) {
        const contentRatio = ratio;  // w/h ratio for content area (inside border)

        if (isCardinal) {
          // Cardinal edge: dragged axis leads, other axis follows
          if (edge === 'e' || edge === 'w') {
            // Width leads → compute height from width
            const contentW = w - RECT_BORDER * 2;
            h = Math.round(contentW / contentRatio) + RECT_BORDER * 2;
            // Clamp height to viewport, adjust width if needed
            if (y + h > vh) { h = vh - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          } else {
            // Height leads → compute width from height
            const contentH = h - RECT_BORDER * 2;
            w = Math.round(contentH * contentRatio) + RECT_BORDER * 2;
            // Clamp width to viewport, adjust height if needed
            if (edge === 'n') {
              if (x + w > vw) { w = vw - x; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; y = startRect.y + startRect.h - h; }
            } else {
              if (x + w > vw) { w = vw - x; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; }
            }
          }
        } else {
          // Corner: width leads, height follows; anchor is opposite corner
          const contentW = w - RECT_BORDER * 2;
          h = Math.round(contentW / contentRatio) + RECT_BORDER * 2;
          // For north corners, adjust y to keep bottom edge anchored
          if (edge === 'ne' || edge === 'nw') {
            y = startRect.y + startRect.h - h;
            if (y < minY) { y = minY; h = startRect.y + startRect.h - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          }
          if (y + h > vh) { h = vh - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          // For west corners, adjust x to keep right edge anchored
          if (edge === 'nw' || edge === 'sw') {
            x = startRect.x + startRect.w - w;
            if (x < 0) { x = 0; w = startRect.x + startRect.w; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; }
          }
        }
      }

      // Snap to even so output dimensions are always even (H.264 requirement)
      this.rect.value = { x, y, w: w & ~1, h: h & ~1 };
      this.requestCaptureFrame();
      m.redraw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      this.requestLocationUpdate();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
}
