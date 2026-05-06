/**
 * AnimatedCapture - Animated capture mode orchestration
 *
 * Manages animated mode lifecycle (enter/exit/toggle), data window locking,
 * dry run playback, anim info display, and animated frame capture.
 */

import m from 'mithril';
import { signal, effect, type Signal, type ReadonlySignal } from '@preact/signals-core';
import { interpolateCamera, type KeyframeManager, type ZoomInterp } from './keyframe';
import {
  timeToPercent, timeToFrame, createFrameTimeMapper,
  frameToSMPTE, formatDateCompact, formatTimeHHMM,
} from './helpers';
import type { AuroraService } from '../aurora-service';
import type { StateService } from '../state-service';
import type { OptionsService } from '../options-service';
import type { QueueService } from '../queue/queue-service';
import type { TimestepService } from '../timestep/timestep-service';
import type { QueueStats } from '../../config/types';

export type CaptureType = 'simple' | 'animated';

export class AnimatedCapture {
  readonly captureType: Signal<CaptureType> = signal('simple');
  readonly dryRunning: Signal<boolean> = signal(false);
  private dryRunAborted = false;
  private disposeTimeClamp: (() => void) | null = null;
  private disposeQueueWait: (() => void) | null = null;

  constructor(
    readonly km: KeyframeManager,
    private readonly auroraService: AuroraService,
    private readonly stateService: StateService,
    private readonly queueService: QueueService,
    private readonly timestepService: TimestepService,
    private readonly optionsService: OptionsService,
    private readonly queueStats: Signal<QueueStats>,
    private readonly totalFrames: ReadonlySignal<number>,
    private readonly frameIndex: Signal<number>,
  ) {}

  private get options() { return this.optionsService.options.value.capture; }
  private get currentTimeMs() { return this.stateService.viewState.value.time.getTime(); }

  get startTime(): number { return this.km.keyframes.value[0]?.time ?? 0; }
  get endTime(): number { const kfs = this.km.keyframes.value; return kfs[kfs.length - 1]?.time ?? 0; }

  // ── Toggle / Enter / Exit ───────────────────────────────────────

  toggleType(): void {
    if (this.captureType.value === 'simple') {
      this.enter();
    } else {
      this.exit();
    }
    this.optionsService.update(d => { d.capture.lastCaptureType = this.captureType.value; });
    m.redraw();
  }

  enter(): void {
    this.captureType.value = 'animated';

    // Nudge time to trigger queue loading the full slot window
    const currentTime = this.stateService.viewState.value.time;
    console.log('[capture] nudge +5min to trigger queue');
    this.stateService.setTime(new Date(currentTime.getTime() + 5 * 60_000));
    this.stateService.setTime(currentTime);

    // Wait for queue to go busy then idle. If it never goes busy
    // (everything cached), a fallback timeout locks after 200ms.
    let seenBusy = false;
    const fallback = setTimeout(() => {
      if (this.disposeQueueWait) {
        this.disposeQueueWait();
        this.disposeQueueWait = null;
        this.lockDataWindow();
      }
    }, 200);
    this.disposeQueueWait = effect(() => {
      const idle = this.queueStats.value.itemsQueued === 0;
      if (!idle) {
        seenBusy = true;
      } else if (seenBusy) {
        clearTimeout(fallback);
        queueMicrotask(() => {
          if (!this.disposeQueueWait) return;
          this.disposeQueueWait();
          this.disposeQueueWait = null;
          this.lockDataWindow();
        });
      }
    });
  }

  exit(): void {
    this.disposeQueueWait?.();
    this.disposeQueueWait = null;
    this.disposeTimeClamp?.();
    this.disposeTimeClamp = null;
    this.queueService.paused.value = false;
    this.km.reset();
    this.captureType.value = 'simple';
  }

  /** Clean up effects without resetting captureType (for CaptureService.exit()) */
  cleanup(): void {
    this.disposeQueueWait?.();
    this.disposeQueueWait = null;
    this.disposeTimeClamp?.();
    this.disposeTimeClamp = null;
    if (this.captureType.value === 'animated') {
      this.queueService.paused.value = false;
    }
    this.km.reset();
  }

  private lockDataWindow(): void {
    const ts = this.timestepService;
    const numSlots = this.auroraService.optionsMirror.value!.engine.timeslotsPerLayer;
    const currentTime = this.stateService.viewState.value.time;
    const window = ts.getWindow(currentTime, numSlots);
    const windowMs = window.map(t => ts.toDate(t).getTime());
    const firstMs = Math.min(...windowMs);
    const lastMs = Math.max(...windowMs);

    this.km.initFromWindow(firstMs, lastMs);
    this.queueService.paused.value = true;

    // Install time clamp effect
    this.disposeTimeClamp = effect(() => {
      const timeMs = this.stateService.viewState.value.time.getTime();
      if (timeMs < this.km.dataWindowStart) {
        this.stateService.setTime(new Date(this.km.dataWindowStart));
      } else if (timeMs > this.km.dataWindowEnd) {
        this.stateService.setTime(new Date(this.km.dataWindowEnd));
      }
      m.redraw();
    });

    console.log('[capture] locked: %s → %s', formatDateCompact(firstMs), formatDateCompact(lastMs));
    m.redraw();
  }

  // ── Anim info ───────────────────────────────────────────────────

  /** Compute anim info from current state or a given frame number */
  getAnimInfo(frame?: number): { timeLabel: string; smpte: string; frameLabel: string } {
    const kfs = this.km.keyframes.value;
    const fps = Number(this.options.fps);
    const totalFrames = this.totalFrames.value;

    let weatherTimeMs: number;
    if (frame !== undefined) {
      // During preview/recording: compute weather time from frame
      const mapper = createFrameTimeMapper(kfs[0]!.time, kfs[kfs.length - 1]!.time, totalFrames);
      weatherTimeMs = mapper(frame);
    } else {
      // Ready mode: active keyframe time, or current view time
      const activeId = this.km.activeKeyframeId.value;
      const activeKf = activeId !== null ? kfs.find(k => k.id === activeId) : null;
      weatherTimeMs = activeKf ? activeKf.time : this.currentTimeMs;
      frame = timeToFrame(weatherTimeMs, this.km.dataWindowStart, this.km.dataWindowEnd, totalFrames);
    }

    return {
      timeLabel: `${formatTimeHHMM(weatherTimeMs)} UTC`,
      smpte: frameToSMPTE(frame, fps),
      frameLabel: `${frame}/${totalFrames}`,
    };
  }

  /** Write anim info directly to DOM (for use during dry run / recording) */
  updateAnimInfoDOM(frame: number): void {
    const info = this.getAnimInfo(frame);
    const spans = document.querySelector('.capture-anim-info')?.querySelectorAll('span');
    if (spans && spans.length >= 3) {
      spans[0]!.textContent = info.timeLabel;
      spans[1]!.textContent = info.smpte;
      spans[2]!.textContent = info.frameLabel;
    }
  }

  // ── Dry run ─────────────────────────────────────────────────────

  async dryRun(): Promise<void> {
    if (this.captureType.value !== 'animated') return;
    if (this.km.keyframes.value.length < 2) return;
    if (this.dryRunning.value) return;

    const kfs = this.km.keyframes.value;
    console.log('[capture] dry run: %s → %s, %d frames',
      formatDateCompact(kfs[0]!.time), formatDateCompact(kfs[kfs.length - 1]!.time), this.totalFrames.value);
    const t0 = performance.now();

    this.dryRunning.value = true;
    this.dryRunAborted = false;
    this.frameIndex.value = 0;

    try {
      await this.runFrameLoop({ capture: false, aborted: () => this.dryRunAborted });
    } finally {
      console.log('[capture] dry run done: %ss', ((performance.now() - t0) / 1000).toFixed(1));
      this.auroraService.recording = false;
      this.dryRunning.value = false;
      if (!this.dryRunAborted) {
        const lastKf = kfs[kfs.length - 1]!;
        this.km.activate(lastKf.id);
      }
      m.redraw();
    }
  }

  abortDryRun(): void {
    this.dryRunAborted = true;
  }

  // ── Animated recording (streaming capture) ──────────────────────

  async captureFrames(opts: {
    aborted: () => boolean;
    onFrame: (bitmap: ImageBitmap, weatherTime: number) => Promise<void>;
  }): Promise<boolean> {
    this.frameIndex.value = 0;
    return this.runFrameLoop({ capture: true, aborted: opts.aborted, onFrame: opts.onFrame });
  }

  // ── Shared frame loop ──────────────────────────────────────────

  /**
   * Iterate all frames: interpolate camera, render, update UI.
   * capture=false (dry run): waitForFrameComplete, pace at fps
   * capture=true (record):   arm captureFrame, waitForExportFrame, stream via onFrame
   * Returns true if completed, false if aborted.
   */
  private async runFrameLoop(opts: {
    capture: boolean;
    aborted: () => boolean;
    onFrame?: (bitmap: ImageBitmap, weatherTime: number) => Promise<void>;
  }): Promise<boolean> {
    const aurora = this.auroraService;
    const camera = aurora.getCamera();
    const kfs = this.km.getInterpolationKeyframes();
    const totalFrames = this.totalFrames.value;
    const weatherTimeAt = createFrameTimeMapper(kfs[0]!.time, kfs[kfs.length - 1]!.time, totalFrames);

    aurora.recording = true;
    this.km.activeKeyframeId.value = null;

    const timeIndicator = document.querySelector('.capture-bar-time-indicator') as HTMLElement | null;
    const frameDuration = 1000 / Number(this.options.fps);
    const runStart = performance.now();

    for (let i = 0; i < totalFrames; i++) {
      if (opts.aborted()) return false;

      const weatherTime = weatherTimeAt(i);
      const frame = i + 1;

      // 1. Update UI before render (direct DOM, no m.redraw at 30fps)
      this.frameIndex.value = frame;
      this.updateAnimInfoDOM(frame);
      const statusEl = document.querySelector('.capture-status');
      if (statusEl) statusEl.textContent = `Capturing ${frame}/${totalFrames}`;
      const progressEl = document.querySelector('.capture-bar-progress');
      if (progressEl) progressEl.textContent = `${frame}/${totalFrames}`;
      if (timeIndicator) {
        timeIndicator.style.left = `${timeToPercent(weatherTime, this.km.dataWindowStart, this.km.dataWindowEnd)}%`;
      }

      // 2. Interpolate camera, set state
      const cam = interpolateCamera(kfs, weatherTime, this.km.wrap, this.options.zoomInterp as ZoomInterp);
      this.stateService.setTime(new Date(weatherTime));
      camera.setPosition(cam.lat, cam.lon, cam.distance);
      camera.update();

      // 3. Render + wait
      if (opts.capture) {
        aurora.send({ type: 'captureFrame' });
        const snapshot = aurora.getCameraSnapshot();
        aurora.send({ type: 'render', camera: snapshot, time: weatherTime });
        const bitmap = await aurora.waitForExportFrame();
        await opts.onFrame!(bitmap, weatherTime);
      } else {
        const snapshot = aurora.getCameraSnapshot();
        aurora.send({ type: 'render', camera: snapshot, time: weatherTime });
        await aurora.waitForFrameComplete();
        // Pace to absolute timeline
        const targetTime = runStart + frame * frameDuration;
        const wait = targetTime - performance.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
    }

    return !opts.aborted();
  }
}
