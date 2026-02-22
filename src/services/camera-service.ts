/**
 * CameraService - Camera capture mode state machine
 *
 * Manages camera overlay state: mode transitions, rect position/size,
 * drag/resize interactions, and duration/frame tracking.
 *
 * Modes: off → ready → recording → done → ready → off
 */

import m from 'mithril';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals-core';
import type { ConfigService } from './config-service';
import type { AuroraService } from './aurora-service';
import type { StateService } from './state-service';
import type { OptionsService } from './options-service';
import type { QueueStats } from '../config/types';

type CameraMode = 'off' | 'ready' | 'recording' | 'done';
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type PaletteMode = 'scene' | 'grayscale' | 'per-frame';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CameraService {
  readonly mode: Signal<CameraMode> = signal('off');
  readonly rect: Signal<Rect>;
  readonly frameIndex: Signal<number> = signal(0);
  readonly totalFrames: ReadonlySignal<number>;
  readonly palette: Signal<number[][] | null> = signal(null);

  private readonly configService: ConfigService;
  private optionsService: OptionsService | null = null;
  private auroraService: AuroraService | null = null;
  private stateService: StateService | null = null;
  private paletteCanvas: OffscreenCanvas | null = null;
  private queueStats: Signal<QueueStats> | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private captureDebounce: ReturnType<typeof setTimeout> | null = null;
  private gifBlob: Blob | null = null;
  private _downloadUrl: string | null = null;
  private _downloadName = 'zero.hypatia.gif';
  private aborted = false;

  constructor(configService: ConfigService) {
    this.configService = configService;
    const cfg = configService.getConfig().cameraUI;

    // Center rect in viewport
    const x = Math.round((window.innerWidth - cfg.rectDefaultSize) / 2);
    const y = Math.round((window.innerHeight - cfg.rectDefaultSize * 0.75) / 2);
    this.rect = signal({ x, y, w: cfg.rectDefaultSize, h: Math.round(cfg.rectDefaultSize * 0.75) });

    this.totalFrames = computed(() => this.getDuration() * this.getFps());
  }

  /** Wire QueueService after construction (avoids circular dep) */
  setQueueService(queueStats: Signal<QueueStats>): void {
    this.queueStats = queueStats;
  }

  /** Wire AuroraService after GPU init (avoids circular dep) */
  setAuroraService(auroraService: AuroraService): void {
    this.auroraService = auroraService;
    auroraService.onExportFrame = (bitmap: ImageBitmap) => this.extractPalette(bitmap);
  }

  /** Wire StateService for frozen time during recording */
  setStateService(stateService: StateService): void {
    this.stateService = stateService;
  }

  /** Wire OptionsService for camera settings */
  setOptionsService(optionsService: OptionsService): void {
    this.optionsService = optionsService;
  }

  // ── Camera option accessors (from OptionsService) ──────────────

  getDuration(): number {
    return Number(this.optionsService!.options.value.camera.duration);
  }

  getFps(): number {
    return Number(this.optionsService!.options.value.camera.fps);
  }

  get nativeDpr(): boolean {
    return this.optionsService!.options.value.camera.nativeDpr;
  }

  get paletteMode(): PaletteMode {
    return this.optionsService!.options.value.camera.paletteMode;
  }

  get isQueueIdle(): boolean {
    return !this.queueStats || this.queueStats.value.itemsQueued === 0;
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
  }

  record(): void {
    if (this.mode.value !== 'ready') return;
    if (!this.isQueueIdle) return;
    if (this.paletteMode === 'scene' && !this.palette.value) return;
    this.mode.value = 'recording';
    this.frameIndex.value = 0;
    this.aborted = false;
    this.gifBlob = null;
    this.runRecordingLoop();
    m.redraw();
  }

  stop(): void {
    if (this.mode.value !== 'recording') return;
    this.aborted = true;
    // Mode transition happens when loop detects abort
  }

  exit(): void {
    if (this.mode.value === 'off') return;
    if (this.mode.value === 'recording') this.aborted = true;
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    this.mode.value = 'off';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.gifBlob = null;
    this.revokeDownloadUrl();
    this.auroraService!.recording = false;
    this.removeEscapeHandler();
    m.redraw();
  }

  get downloadUrl(): string | null {
    return this._downloadUrl;
  }

  get downloadName(): string {
    return this._downloadName;
  }

  private buildFilename(timeMs: number): string {
    const d = new Date(timeMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}Z`;
    const cam = this.auroraService!.getCamera();
    const lat = cam.lat.toFixed(1);
    const lon = cam.lon.toFixed(1);
    return `zero.hypatia-${dt}-${lat}-${lon}.gif`;
  }

  private revokeDownloadUrl(): void {
    if (this._downloadUrl) {
      URL.revokeObjectURL(this._downloadUrl);
      this._downloadUrl = null;
    }
  }

  // ── Recording loop ───────────────────────────────────────────────

  private async runRecordingLoop(): Promise<void> {
    const aurora = this.auroraService!;
    const fps = this.getFps();
    const fixedDtMs = 1000 / fps;
    const totalFrames = this.totalFrames.value;
    const frozenTime = this.stateService!.viewState.value.time.getTime();
    const palMode = this.paletteMode;

    aurora.recording = true;
    const prevHandler = aurora.onExportFrame;

    try {
      const gifencUrl = '/external/gifenc.js';
      const { GIFEncoder, applyPalette, quantize } = await import(/* @vite-ignore */ gifencUrl);
      const encoder = new GIFEncoder();
      const delay = Math.round(1000 / fps);

      // Palette strategy: scene/grayscale use a single palette, per-frame quantizes each
      const grayscalePalette = palMode === 'grayscale' ? this.buildGrayscalePalette() : null;
      const fixedPalette = palMode === 'scene' ? this.palette.value!
        : grayscalePalette;

      for (let i = 0; i < totalFrames; i++) {
        if (this.aborted) break;

        const bitmap = await this.captureOneFrame(aurora, frozenTime, fixedDtMs);
        const rgba = this.cropBitmap(bitmap);
        const { w, h } = this.getOutputDimensions();
        const palette = fixedPalette ?? quantize(rgba, 256);
        // Grayscale: direct luminance indexing (bypasses applyPalette's rgb565 cache)
        const indexed = grayscalePalette ? this.rgbaToLuminance(rgba) : applyPalette(rgba, palette);
        encoder.writeFrame(indexed, w, h, { palette, delay });
        this.frameIndex.value = i + 1;
        await new Promise<void>(r => setTimeout(r, 0));
        m.redraw();
      }

      if (!this.aborted) {
        encoder.finish();
        this.gifBlob = new Blob([encoder.bytes()], { type: 'image/gif' });
        this.revokeDownloadUrl();
        this._downloadUrl = URL.createObjectURL(this.gifBlob);
        this._downloadName = this.buildFilename(frozenTime);
        this.mode.value = 'done';
      } else {
        this.mode.value = 'ready';
      }
    } finally {
      aurora.recording = false;
      aurora.onExportFrame = prevHandler;
      m.redraw();
    }
  }

  private captureOneFrame(
    aurora: AuroraService,
    time: number,
    fixedDtMs: number,
  ): Promise<ImageBitmap> {
    return new Promise(resolve => {
      aurora.onExportFrame = resolve;
      const camera = aurora.getCameraSnapshot();
      aurora.send({ type: 'captureFrame' });
      aurora.send({ type: 'render', camera, time, fixedDtMs });
    });
  }

  private cropBitmap(bitmap: ImageBitmap): Uint8ClampedArray {
    const rect = this.rect.value;
    const dpr = window.devicePixelRatio;
    const srcX = Math.round(rect.x * dpr);
    const srcY = Math.round(rect.y * dpr);
    const srcW = Math.round(rect.w * dpr);
    const srcH = Math.round(rect.h * dpr);
    // Native: keep device pixels; default: downscale to CSS pixels
    const outW = this.nativeDpr ? srcW : rect.w;
    const outH = this.nativeDpr ? srcH : rect.h;

    if (!this.paletteCanvas || this.paletteCanvas.width !== outW || this.paletteCanvas.height !== outH) {
      this.paletteCanvas = new OffscreenCanvas(outW, outH);
    }

    const ctx = this.paletteCanvas.getContext('2d')!;
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    bitmap.close();
    return ctx.getImageData(0, 0, outW, outH).data;
  }

  private getOutputDimensions(): { w: number; h: number } {
    const rect = this.rect.value;
    if (this.nativeDpr) {
      const dpr = window.devicePixelRatio;
      return { w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr) };
    }
    return { w: rect.w, h: rect.h };
  }

  private buildGrayscalePalette(): number[][] {
    return Array.from({ length: 256 }, (_, i) => [i, i, i]);
  }

  /** Direct RGB→luminance indexing, avoids gifenc's rgb565 cache banding */
  private rgbaToLuminance(rgba: Uint8ClampedArray): Uint8Array {
    const n = rgba.length >> 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const off = i << 2;
      out[i] = (rgba[off]! * 77 + rgba[off + 1]! * 150 + rgba[off + 2]! * 29) >> 8;
    }
    return out;
  }

  // ── Frame capture & palette extraction ───────────────────────────

  requestCaptureFrame(): void {
    if (this.captureDebounce) clearTimeout(this.captureDebounce);
    this.captureDebounce = setTimeout(() => {
      this.captureDebounce = null;
      this.auroraService?.send({ type: 'captureFrame' });
    }, 150);
  }

  private async extractPalette(bitmap: ImageBitmap): Promise<void> {
    if (this.mode.value === 'off') return;

    const rect = this.rect.value;
    const dpr = window.devicePixelRatio;
    const srcX = Math.round(rect.x * dpr);
    const srcY = Math.round(rect.y * dpr);
    const srcW = Math.round(rect.w * dpr);
    const srcH = Math.round(rect.h * dpr);
    // Match recording resolution: CSS pixels or device pixels
    const outW = this.nativeDpr ? srcW : rect.w;
    const outH = this.nativeDpr ? srcH : rect.h;

    if (!this.paletteCanvas || this.paletteCanvas.width !== outW || this.paletteCanvas.height !== outH) {
      this.paletteCanvas = new OffscreenCanvas(outW, outH);
    }

    const ctx = this.paletteCanvas.getContext('2d')!;
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, outW, outH);
    const gifencUrl = '/external/gifenc.js';
    const { quantize } = await import(/* @vite-ignore */ gifencUrl);
    const palette = quantize(imageData.data, 256);

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

  startMove(e: PointerEvent): void {
    if (this.mode.value === 'recording' || this.mode.value === 'done') return;
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
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ── Rect resize ───────────────────────────────────────────────────

  startResize(e: PointerEvent, edge: Edge): void {
    if (this.mode.value === 'recording' || this.mode.value === 'done') return;
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

      this.rect.value = { x, y, w, h };
      this.requestCaptureFrame();
      m.redraw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
}
