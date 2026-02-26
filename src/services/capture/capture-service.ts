/**
 * CaptureService - Capture mode state machine
 *
 * Manages capture overlay state: mode transitions, rect position/size,
 * drag/resize interactions, and duration/frame tracking.
 *
 * Modes: off → ready → capturing → processing → done → ready → off
 *
 * Delegates to:
 *   KeyframeManager  — keyframe state and CRUD
 *   AnimatedCapture   — animated mode lifecycle, dry run, frame capture
 */

import m from 'mithril';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals-core';
import { extractPalette, createGifSession } from './gif';
import { createMp4Session } from './mp4';
import { reverseGeocode } from './location';
import { loadLogo, createDecorator } from './decorate';
import { KeyframeManager } from './keyframe';
import { AnimatedCapture } from './animated-capture';
import { formatTimestampUTC, formatDateFilename, formatFileSize, snapEven } from './helpers';
import type { AuroraService } from '../aurora-service';
import type { StateService } from '../state-service';
import type { OptionsService } from '../options-service';
import type { QueueService } from '../queue/queue-service';
import type { TimestepService } from '../timestep/timestep-service';
import type { QueueStats } from '../../config/types';

export type { CaptureType } from './animated-capture';

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

  if (saved && saved.w >= RECT_MIN_WIDTH && saved.h >= RECT_MIN_HEIGHT) {
    if (saved.x >= 0 && saved.y >= minY && saved.x + saved.w <= vw && saved.y + saved.h <= vh) {
      return { ...saved };
    }
    const x = Math.round((vw - saved.w) / 2);
    const y = Math.round((vh - saved.h) / 2);
    if (x >= 0 && y >= minY && x + saved.w <= vw && y + saved.h <= vh) {
      return { x, y, w: saved.w, h: saved.h };
    }
  }

  let w = RECT_DEFAULT_SIZE;
  let h: number;
  if (ratio !== null) {
    h = Math.round((w - RECT_BORDER * 2) / ratio) + RECT_BORDER * 2;
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
interface Rect { x: number; y: number; w: number; h: number }

export class CaptureService {

  // ── Fields ──────────────────────────────────────────────────────

  readonly mode: Signal<CaptureMode> = signal('off');
  readonly rect: Signal<Rect>;
  readonly frameIndex: Signal<number> = signal(0);
  readonly totalFrames: ReadonlySignal<number>;
  readonly palette: Signal<number[][] | null> = signal(null);
  readonly locationLabel: Signal<string> = signal('');

  readonly km: KeyframeManager;
  readonly animated: AnimatedCapture;

  private readonly optionsService: OptionsService;
  private readonly stateService: StateService;
  private readonly auroraService: AuroraService;
  private readonly queueStats: Signal<QueueStats>;
  private paletteCanvas: OffscreenCanvas | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private captureDebounce: ReturnType<typeof setTimeout> | null = null;
  private locationDebounce: ReturnType<typeof setTimeout> | null = null;
  private geocodeAvailable = true;
  private locationDirty = false;
  private paletteRetries = 0;
  downloadUrl: string | null = null;
  downloadName = 'zero.hypatia';
  downloadSize = '';
  private downloadBlob: Blob | null = null;
  private aborted = false;

  // ── Constructor ─────────────────────────────────────────────────

  constructor(
    optionsService: OptionsService,
    stateService: StateService,
    queueStats: Signal<QueueStats>,
    auroraService: AuroraService,
    queueService: QueueService,
    timestepService: TimestepService,
  ) {
    this.optionsService = optionsService;
    this.stateService = stateService;
    this.auroraService = auroraService;
    this.queueStats = queueStats;
    auroraService.onExportFrame = (bitmap: ImageBitmap) => this.onPreviewFrame(bitmap);

    const saved = optionsService.options.value.capture.lastRect;
    const ratio = ASPECT_RATIOS[optionsService.options.value.capture.aspectRatio] ?? null;
    this.rect = signal(resolveInitialRect(saved, ratio, 0));
    this.totalFrames = computed(() => {
      const { duration, fps } = this.options;
      return Number(duration) * Number(fps);
    });

    this.km = new KeyframeManager(auroraService, stateService);
    this.animated = new AnimatedCapture(
      this.km, auroraService, stateService,
      queueService, timestepService, optionsService,
      queueStats, this.totalFrames, this.frameIndex,
    );
  }

  // ── Getters ─────────────────────────────────────────────────────

  private get options() { return this.optionsService.options.value.capture; }

  get isQueueIdle(): boolean {
    return this.queueStats.value.itemsQueued === 0;
  }

  get canShare(): boolean {
    if (!this.downloadBlob || !navigator.canShare) return false;
    const file = new File([this.downloadBlob], this.downloadName, { type: this.downloadBlob.type });
    return navigator.canShare({ files: [file] });
  }

  private get isLocked(): boolean {
    const m = this.mode.value;
    return m === 'capturing' || m === 'processing' || m === 'done';
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  enter(): void {
    if (this.mode.value !== 'off') return;
    this.mode.value = 'ready';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.installEscapeHandler();
    this.requestCaptureFrame();
    // Restore last capture type from persisted options
    const lastType = this.optionsService.options.value.capture.lastCaptureType;
    if (lastType === 'animated') {
      this.animated.enter();
    } else {
      this.animated.captureType.value = 'simple';
    }
    m.redraw();
    requestAnimationFrame(() => this.requestLocationUpdate(0));
  }

  exit(): void {
    if (this.mode.value === 'off') return;
    if (this.mode.value === 'capturing' || this.mode.value === 'processing') this.aborted = true;
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    if (this.locationDebounce) { clearTimeout(this.locationDebounce); this.locationDebounce = null; }
    this.animated.cleanup();
    this.mode.value = 'off';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.locationLabel.value = '';
    this.geocodeAvailable = true;
    this.locationDirty = false;
    this.revokeDownloadUrl();
    this.auroraService.recording = false;
    this.removeEscapeHandler();
    m.redraw();
  }

  toggleCaptureType(): void {
    if (this.mode.value !== 'ready') return;
    this.animated.toggleType();
  }

  record(): void {
    if (this.mode.value !== 'ready') return;
    // In simple mode, GIF requires palette (except grayscale)
    if (this.animated.captureType.value === 'simple' &&
        this.options.format === 'gif' && this.options.paletteMode !== 'grayscale' && !this.palette.value) return;
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    this.optionsService.update(d => { d.capture.lastRect = { ...this.rect.value }; });
    this.mode.value = 'capturing';
    this.frameIndex.value = 0;
    this.aborted = false;
    if (this.animated.captureType.value === 'animated') {
      this.runAnimatedRecordingLoop();
    } else {
      this.runSimpleRecordingLoop();
    }
    m.redraw();
  }

  stop(): void {
    if (this.mode.value !== 'capturing' && this.mode.value !== 'processing') return;
    this.aborted = true;
  }

  // ── Recording loops ─────────────────────────────────────────────

  private async runSimpleRecordingLoop(): Promise<void> {
    const aurora = this.auroraService;
    const { format, fps: fpsStr, paletteMode, bitrate: bitrateStr } = this.options;
    const fps = Number(fpsStr);
    const fixedDtMs = 1000 / fps;
    const totalFrames = this.totalFrames.value;
    const frozenTime = this.stateService.viewState.value.time.getTime();

    aurora.recording = true;

    try {
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

      if (this.aborted) {
        for (const bmp of bitmaps) bmp.close();
        this.mode.value = 'ready';
        return;
      }

      this.mode.value = 'processing';
      this.frameIndex.value = 0;
      m.redraw();

      const { w: outW, h: outH } = this.getOutputDimensions();
      const label = this.options.label ? this.locationLabel.value : '';
      const timestamp = formatTimestampUTC(frozenTime);
      const logo = await loadLogo();
      const scale = outW / this.rect.value.w;
      const decorator = createDecorator(outW, outH, label, timestamp, logo, scale);

      const comment = `zero.hypatia.earth | ${timestamp}${label ? ` | ${label}` : ''}\nData: ECMWF IFS \u00b7 CC BY 4.0`;
      const title = label ? `Weather \u2014 ${label}` : `Weather \u2014 ${timestamp}`;
      const session = format === 'mp4'
        ? createMp4Session(fps, outW, outH, Number(bitrateStr), { title, timestamp, label, comment })
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
        await new Promise<void>(r => setTimeout(r, 0));
      }

      if (!this.aborted) {
        this.finishRecording(await session.finish(), this.buildFilename(frozenTime));
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

  private async runAnimatedRecordingLoop(): Promise<void> {
    const aurora = this.auroraService;

    try {
      // Set up encoder before capture — frames stream through inline
      const startTime = this.animated.startTime;
      const { format, fps: fpsStr, paletteMode, bitrate: bitrateStr } = this.options;
      const fps = Number(fpsStr);
      const { w: outW, h: outH } = this.getOutputDimensions();

      const label = this.options.label ? this.locationLabel.value : '';
      const baseTimestamp = formatTimestampUTC(startTime);
      const logo = await loadLogo();
      const scale = outW / this.rect.value.w;
      const decorator = createDecorator(outW, outH, label, baseTimestamp, logo, scale);

      const comment = `zero.hypatia.earth | ${baseTimestamp}${label ? ` | ${label}` : ''}\nData: ECMWF IFS \u00b7 CC BY 4.0`;
      const title = label ? `Weather \u2014 ${label}` : `Weather \u2014 ${baseTimestamp}`;
      const session = format === 'mp4'
        ? createMp4Session(fps, outW, outH, Number(bitrateStr), { title, timestamp: baseTimestamp, label, comment })
        : createGifSession(fps, paletteMode, this.palette.value, comment);

      const completed = await this.animated.captureFrames({
        aborted: () => this.aborted,
        onFrame: async (bitmap, weatherTime) => {
          const rgba = this.cropBitmap(bitmap, outW, outH);
          const frameTs = formatTimestampUTC(weatherTime);
          const decorated = decorator.decorate(rgba, frameTs);
          session.addFrame(decorated, outW, outH);
        },
      });

      if (completed) {
        this.finishRecording(await session.finish(), this.buildAnimatedFilename(startTime, this.animated.endTime));
      } else {
        this.mode.value = 'ready';
      }
    } finally {
      aurora.recording = false;
      m.redraw();
    }
  }

  // ── Recording helpers ───────────────────────────────────────────

  private finishRecording(blob: Blob, filename: string): void {
    this.revokeDownloadUrl();
    this.downloadBlob = blob;
    this.downloadUrl = URL.createObjectURL(blob);
    this.downloadName = filename;
    this.downloadSize = formatFileSize(blob.size);
    this.mode.value = 'done';
  }

  private buildFilename(timeMs: number): string {
    const loc = this.locationLabel.value.trim().replace(/[<>:"/\\|?*]+/g, '');
    const ext = this.options.format;
    const dt = formatDateFilename(timeMs);
    return loc ? `zero.hypatia-${dt}-${loc}.${ext}` : `zero.hypatia-${dt}.${ext}`;
  }

  private buildAnimatedFilename(startMs: number, endMs: number): string {
    const loc = this.locationLabel.value.trim().replace(/[<>:"/\\|?*]+/g, '');
    const ext = this.options.format;
    const range = `${formatDateFilename(startMs)}-${formatDateFilename(endMs)}`;
    return loc ? `zero.hypatia-${range}-${loc}.${ext}` : `zero.hypatia-${range}.${ext}`;
  }

  private revokeDownloadUrl(): void {
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
    this.downloadBlob = null;
  }

  // ── Frame capture & palette ─────────────────────────────────────

  private cropBitmap(bitmap: ImageBitmap, outW: number, outH: number): Uint8ClampedArray {
    const rect = this.rect.value;
    const dpr = window.devicePixelRatio;
    const border = 2;
    let srcX = Math.round((rect.x + border) * dpr);
    let srcY = Math.round((rect.y + border) * dpr);
    let srcW = Math.round((rect.w - border * 2) * dpr);
    let srcH = Math.round((rect.h - border * 2) * dpr);

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
    const border = 2;
    const contentW = rect.w - border * 2;
    const contentH = rect.h - border * 2;
    if (this.options.nativeDpr) {
      const dpr = window.devicePixelRatio;
      return { w: snapEven(Math.round(contentW * dpr)), h: snapEven(Math.round(contentH * dpr)) };
    }
    return { w: contentW, h: contentH };
  }

  requestCaptureFrame(): void {
    if (this.captureDebounce) clearTimeout(this.captureDebounce);
    this.captureDebounce = setTimeout(() => {
      this.captureDebounce = null;
      this.auroraService?.send({ type: 'captureFrame' });
    }, 150);
  }

  setLocationLabel(label: string): void {
    this.locationLabel.value = label;
    this.locationDirty = true;
  }

  requestLocationUpdate(delay = 1000): void {
    if (!this.options.label || !this.geocodeAvailable || this.locationDirty) return;
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

  private async onPreviewFrame(bitmap: ImageBitmap): Promise<void> {
    if (this.mode.value === 'off') return;
    const palette = await extractPalette(bitmap, this.rect.value, this.options.nativeDpr);
    if (palette.every(([r, g, b]) => r === 0 && g === 0 && b === 0) && this.paletteRetries < 3) {
      this.paletteRetries++;
      this.requestCaptureFrame();
      return;
    }
    this.paletteRetries = 0;
    this.palette.value = palette;
    m.redraw();
  }

  // ── UI interactions ─────────────────────────────────────────────

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

  async share(): Promise<void> {
    if (!this.downloadBlob) return;
    const file = new File([this.downloadBlob], this.downloadName, { type: this.downloadBlob.type });
    await navigator.share({ files: [file] });
  }

  private getHeaderHeight(): number {
    const el = document.querySelector('.capture-header');
    return el ? el.getBoundingClientRect().height : 0;
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

      if (edge.includes('e')) {
        w = Math.max(RECT_MIN_WIDTH, Math.min(vw - x, startRect.w + dx));
      }
      if (edge.includes('w')) {
        x = Math.max(0, Math.min(startRect.x + dx, startRect.x + startRect.w - RECT_MIN_WIDTH));
        w = startRect.x + startRect.w - x;
      }
      if (edge.includes('s')) {
        h = Math.max(RECT_MIN_HEIGHT, Math.min(vh - y, startRect.h + dy));
      }
      if (edge === 'n' || edge === 'ne' || edge === 'nw') {
        y = Math.max(minY, Math.min(startRect.y + dy, startRect.y + startRect.h - RECT_MIN_HEIGHT));
        h = startRect.y + startRect.h - y;
      }

      if (ratio !== null) {
        const contentRatio = ratio;

        if (isCardinal) {
          if (edge === 'e' || edge === 'w') {
            const contentW = w - RECT_BORDER * 2;
            h = Math.round(contentW / contentRatio) + RECT_BORDER * 2;
            if (y + h > vh) { h = vh - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          } else {
            const contentH = h - RECT_BORDER * 2;
            w = Math.round(contentH * contentRatio) + RECT_BORDER * 2;
            if (edge === 'n') {
              if (x + w > vw) { w = vw - x; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; y = startRect.y + startRect.h - h; }
            } else {
              if (x + w > vw) { w = vw - x; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; }
            }
          }
        } else {
          const contentW = w - RECT_BORDER * 2;
          h = Math.round(contentW / contentRatio) + RECT_BORDER * 2;
          if (edge === 'ne' || edge === 'nw') {
            y = startRect.y + startRect.h - h;
            if (y < minY) { y = minY; h = startRect.y + startRect.h - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          }
          if (y + h > vh) { h = vh - y; w = Math.round((h - RECT_BORDER * 2) * contentRatio) + RECT_BORDER * 2; }
          if (edge === 'nw' || edge === 'sw') {
            x = startRect.x + startRect.w - w;
            if (x < 0) { x = 0; w = startRect.x + startRect.w; h = Math.round((w - RECT_BORDER * 2) / contentRatio) + RECT_BORDER * 2; }
          }
        }
      }

      this.rect.value = { x, y, w: snapEven(w), h: snapEven(h) };
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
