/**
 * CaptureService - Camera capture mode state machine
 *
 * Manages camera overlay state: mode transitions, rect position/size,
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
import type { ConfigService } from '../config-service';
import type { AuroraService } from '../aurora-service';
import type { StateService } from '../state-service';
import type { OptionsService } from '../options-service';
import type { QueueStats } from '../../config/types';

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

  private readonly configService: ConfigService;
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
  private aborted = false;

  constructor(
    configService: ConfigService,
    optionsService: OptionsService,
    stateService: StateService,
    queueStats: Signal<QueueStats>,
    auroraService: AuroraService,
  ) {
    this.configService = configService;
    this.optionsService = optionsService;
    this.stateService = stateService;
    this.queueStats = queueStats;
    this.auroraService = auroraService;
    auroraService.onExportFrame = (bitmap: ImageBitmap) => this.onPreviewFrame(bitmap);

    const cfg = configService.getConfig().cameraUI;
    const x = Math.round((window.innerWidth - cfg.rectDefaultSize) / 2);
    const y = Math.round((window.innerHeight - cfg.rectDefaultSize * 0.75) / 2);
    this.rect = signal({ x, y, w: cfg.rectDefaultSize, h: Math.round(cfg.rectDefaultSize * 0.75) });
    this.totalFrames = computed(() => {
      const { duration, fps } = this.options;
      return Number(duration) * Number(fps);
    });
  }

  private get options() {
    return this.optionsService.options.value.camera;
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
    // Delay so .camera-rect DOM exists after redraw
    requestAnimationFrame(() => this.requestLocationUpdate(0));
  }

  record(): void {
    if (this.mode.value !== 'ready') return;
    if (!this.isQueueIdle) return;
    if (this.options.format === 'gif' && this.options.paletteMode !== 'grayscale' && !this.palette.value) return;
    // Cancel pending preview capture to prevent stale exportFrame during capturing
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    this.mode.value = 'capturing';
    this.frameIndex.value = 0;
    this.aborted = false;
    this.runRecordingLoop();
    m.redraw();
  }

  stop(): void {
    if (this.mode.value !== 'capturing') return;
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

  private buildFilename(timeMs: number): string {
    const d = new Date(timeMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}Z`;
    const cam = this.auroraService.getCamera();
    const lat = cam.lat.toFixed(1);
    const lon = cam.lon.toFixed(1);
    const ext = this.options.format;
    return `zero.hypatia-${dt}-${lat}-${lon}.${ext}`;
  }

  private revokeDownloadUrl(): void {
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
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
          this.frameIndex.value = frameIndex;
          m.redraw();
        };
        aurora.onRecordBatchComplete = (batch) => resolve(batch);
        const camera = aurora.getCameraSnapshot();
        aurora.send({ type: 'recordBatch', camera, time: frozenTime, fixedDtMs, totalFrames });
      });

      // Phase 2: processing (crop + encode)
      this.mode.value = 'processing';
      this.frameIndex.value = 0;
      m.redraw();

      // Compute output dimensions once; MP4 needs even values for H.264
      const baseDims = this.getOutputDimensions();
      const outW = format === 'mp4' ? (baseDims.w & ~1) : baseDims.w;
      const outH = format === 'mp4' ? (baseDims.h & ~1) : baseDims.h;

      // Build decorator for header/footer bars
      const label = this.locationLabel.value;
      const d = new Date(frozenTime);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
      const logo = await loadLogo();
      const scale = outW / this.rect.value.w;
      const decorator = createDecorator(outW, outH, label, timestamp, logo, scale);
      const decH = decorator.height;

      const session = format === 'mp4'
        ? createMp4Session(fps, outW, decH)
        : createGifSession(fps, paletteMode, this.palette.value);

      for (let i = 0; i < bitmaps.length; i++) {
        if (this.aborted) break;
        const rgba = this.cropBitmap(bitmaps[i]!, outW, outH);
        const decorated = decorator.decorate(rgba);
        session.addFrame(decorated, outW, decH);
        this.frameIndex.value = i + 1;
        m.redraw();
        // Yield each frame to keep UI responsive during encoding
        await new Promise<void>(r => setTimeout(r, 0));
      }

      if (!this.aborted) {
        const blob = await session.finish();
        this.revokeDownloadUrl();
        this.downloadUrl = URL.createObjectURL(blob);
        this.downloadName = this.buildFilename(frozenTime);
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
    const srcX = Math.round(rect.x * dpr);
    const srcY = Math.round(rect.y * dpr);
    const srcW = Math.round(rect.w * dpr);
    const srcH = Math.round(rect.h * dpr);

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
    if (this.options.nativeDpr) {
      const dpr = window.devicePixelRatio;
      return { w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr) };
    }
    return { w: rect.w, h: rect.h };
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
      const el = document.querySelector('.camera-rect');
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
    // Chrome: first transferToImageBitmap may return black — retry
    if (palette.every(([r, g, b]) => r === 0 && g === 0 && b === 0)) {
      this.requestCaptureFrame();
      return;
    }
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

    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = Math.max(0, Math.min(vw - r.w, ev.clientX - startX));
      const y = Math.max(0, Math.min(vh - r.h, ev.clientY - startY));
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
    const cfg = this.configService.getConfig().cameraUI;
    const startRect = { ...this.rect.value };
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let { x, y, w, h } = startRect;

      // Horizontal edges
      if (edge.includes('e')) {
        w = Math.max(cfg.rectMinWidth, Math.min(vw - x, startRect.w + dx));
      }
      if (edge.includes('w')) {
        const maxShift = startRect.w - cfg.rectMinWidth;
        const shift = Math.min(Math.max(0, dx), maxShift);
        x = Math.max(0, startRect.x + shift);
        w = startRect.x + startRect.w - x;
        if (w < cfg.rectMinWidth) { w = cfg.rectMinWidth; x = startRect.x + startRect.w - w; }
      }

      // Vertical edges
      if (edge.includes('s')) {
        h = Math.max(cfg.rectMinHeight, Math.min(vh - y, startRect.h + dy));
      }
      if (edge === 'n' || edge === 'ne' || edge === 'nw') {
        const maxShift = startRect.h - cfg.rectMinHeight;
        const shift = Math.min(Math.max(0, dy), maxShift);
        y = Math.max(0, startRect.y + shift);
        h = startRect.y + startRect.h - y;
        if (h < cfg.rectMinHeight) { h = cfg.rectMinHeight; y = startRect.y + startRect.h - h; }
      }

      // Snap to 2px grid (even dimensions for encoder compatibility)
      w = w & ~1;
      h = h & ~1;

      this.rect.value = { x, y, w, h };
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
