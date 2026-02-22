/**
 * CameraService - Camera capture mode state machine
 *
 * Manages camera overlay state: mode transitions, rect position/size,
 * drag/resize interactions, and duration/frame tracking.
 *
 * Modes: off → ready → recording → ready → off
 */

import m from 'mithril';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals-core';
import type { ConfigService } from './config-service';
import type { AuroraService } from './aurora-service';
import type { QueueStats } from '../config/types';

type CameraMode = 'off' | 'ready' | 'recording';
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CameraService {
  readonly mode: Signal<CameraMode> = signal('off');
  readonly rect: Signal<Rect>;
  readonly duration: Signal<number>;
  readonly frameIndex: Signal<number> = signal(0);
  readonly totalFrames: ReadonlySignal<number>;
  readonly durations: readonly number[];
  readonly palette: Signal<number[][] | null> = signal(null);

  private readonly configService: ConfigService;
  private auroraService: AuroraService | null = null;
  private paletteCanvas: OffscreenCanvas | null = null;
  private queueStats: Signal<QueueStats> | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private captureDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(configService: ConfigService) {
    this.configService = configService;
    const cfg = configService.getConfig().cameraUI;

    // Center rect in viewport
    const x = Math.round((window.innerWidth - cfg.rectDefaultSize) / 2);
    const y = Math.round((window.innerHeight - cfg.rectDefaultSize * 0.75) / 2);
    this.rect = signal({ x, y, w: cfg.rectDefaultSize, h: Math.round(cfg.rectDefaultSize * 0.75) });

    this.durations = cfg.durations;
    this.duration = signal(cfg.durations[1] as number); // default 3s
    this.totalFrames = computed(() => this.duration.value * cfg.fps);
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

  get isQueueIdle(): boolean {
    return !this.queueStats || this.queueStats.value.status === 'idle';
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
    this.mode.value = 'recording';
    this.frameIndex.value = 0;
    m.redraw();
  }

  stop(): void {
    if (this.mode.value !== 'recording') return;
    this.mode.value = 'ready';
    m.redraw();
  }

  exit(): void {
    if (this.mode.value === 'off') return;
    if (this.captureDebounce) { clearTimeout(this.captureDebounce); this.captureDebounce = null; }
    this.mode.value = 'off';
    this.frameIndex.value = 0;
    this.palette.value = null;
    this.removeEscapeHandler();
    m.redraw();
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

    // Create/reuse offscreen canvas sized to cropped area
    if (!this.paletteCanvas || this.paletteCanvas.width !== srcW || this.paletteCanvas.height !== srcH) {
      this.paletteCanvas = new OffscreenCanvas(srcW, srcH);
    }

    const ctx = this.paletteCanvas.getContext('2d')!;
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, srcW, srcH);
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
    if (this.mode.value === 'recording') return;
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
    if (this.mode.value === 'recording') return;
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
