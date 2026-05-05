/**
 * Aurora Service - Bridge between main thread and Aurora GPU worker
 *
 * Handles:
 * - Worker lifecycle (creation, initialization, cleanup)
 * - Message passing with proper transferables
 * - Render loop coordination via requestAnimationFrame
 * - Perf panel updates
 */

import { effect, signal, type Signal } from '@preact/signals-core';
import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets, CameraSnapshot } from '../aurora/worker';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { OptionsService } from './options-service';
import type { PerfService } from './perf-service';
import { Camera } from '../aurora/camera';
import { setupViewport } from './viewport/viewport';
import type { PaletteId } from './palette-service';
import type { EngineOpts } from '../aurora/types/options';
import type { ZeroOptions } from '../schemas/options.schema';

/** Host-side named→RGB mapping for cities label color. Aurora consumes the
 *  pre-translated triplet via setLayerOptions('cities', {color:[r,g,b]}). */
const CITY_COLORS_RGB: Record<ZeroOptions['cities']['color'], [number, number, number]> = {
  white:   [1, 1, 1],
  black:   [0, 0, 0],
  darkred: [0.55, 0.05, 0.05],
  gold:    [0.85, 0.65, 0.13],
};

/** Built-in layer ids whose UI bind-points drive aurora-side opacity. Excludes
 *  'humidity' from BUILT_IN_LAYERS because it has a ZeroOptions section but no
 *  registered layer folder — it'd be a no-op dispatch. */
const OPACITY_BUILT_INS = ['earth', 'sun', 'graticule', 'cities', 'temp', 'rain', 'clouds', 'pressure', 'wind'] as const;

/** Type guard: value is an object with a palette ID field */
function hasPaletteField(val: unknown): val is { palette: PaletteId } {
  return typeof val === 'object' && val !== null && 'palette' in val && typeof val.palette === 'string';
}

// Re-export types for consumers
export type { AuroraConfig, AuroraAssets, CameraSnapshot } from '../aurora/worker';
export type { Camera } from '../aurora/camera';

/** Performance statistics emitted each frame */
export interface PerfStats {
  fps: number;
  frameMs: number;
  passMs: number;
  dropped: number;
}

/** Rolling average helper */
function createRollingAvg(size: number) {
  const values: number[] = [];
  return {
    push(v: number) {
      values.push(v);
      if (values.length > size) values.shift();
    },
    avg(): number {
      if (values.length === 0) return 0;
      return values.reduce((a, b) => a + b, 0) / values.length;
    },
    clear() {
      values.length = 0;
    },
  };
}

export interface AuroraService {
  init(canvas: HTMLCanvasElement, config: AuroraConfig, assets: AuroraAssets): Promise<void>;
  start(): void;
  cleanup(): void;
  dispose(): void;
  uploadData(param: string, slotIndex: number, data: Float32Array): void;
  activateSlots(param: string, slot0: number, slot1: number, t0: number, t1: number, loadedPoints?: number): void;
  deactivateSlots(param: string): void;
  updatePalette(layer: string, paletteId: PaletteId): void;
  /** Sub-B Phase 5 typed setter — patch aurora's engine-wide options. */
  setEngineOptions(patch: Partial<EngineOpts>): void;
  /** Sub-B Phase 5 typed setter — opts shape narrowed by id at the call site. */
  setLayerOptions(id: string, opts: unknown): void;
  /** Sub-B Phase 5 typed setter — pre-gated opacity 0..1 (host pre-multiplies enabled). */
  setLayerOpacity(id: string, value: number): void;
  getCamera(): Camera;
  setCameraPosition(lat: number, lon: number, distance: number): void;
  memoryStats: Signal<{ allocatedMB: number; capacityMB: number }>;
  userLayerState: Signal<{ layerId: string; error: string } | 'ok' | null>;
  recording: boolean;
  onExportFrame: ((bitmap: ImageBitmap) => void) | null;
  onRecordProgress: ((frameIndex: number) => void) | null;
  onRecordBatchComplete: ((bitmaps: ImageBitmap[]) => void) | null;
  getCameraSnapshot(): CameraSnapshot;
  send(msg: AuroraRequest, transfer?: Transferable[]): void;
  waitForFrameComplete(): Promise<void>;
  waitForExportFrame(): Promise<ImageBitmap>;
  resetPerfStats(): void;
}

export function createAuroraService(
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService,
  perfService: PerfService
): AuroraService {
  // Worker
  const worker = new Worker(
    new URL('../aurora/worker.ts', import.meta.url),
    { type: 'module', name: 'aurora' }
  );

  // Message callbacks
  let onReady: (() => void) | null = null;
  let onFrameComplete: ((timing: { frame: number; pass1: number; pass2: number; pass3: number }, memoryMB: { allocated: number; capacity: number }) => void) | null = null;
  let onExportFrame: ((bitmap: ImageBitmap) => void) | null = null;
  let onRecordProgress: ((frameIndex: number) => void) | null = null;
  let onRecordBatchComplete: ((bitmaps: ImageBitmap[]) => void) | null = null;

  // Promise resolvers for frame-by-frame control
  let frameCompleteResolve: (() => void) | null = null;
  let exportFrameResolve: ((bitmap: ImageBitmap) => void) | null = null;

  // Render loop state
  let renderInFlight = false;
  let droppedFrames = 0;
  let paused = false;
  let recording = false;

  // GPU memory stats (updated each frame from worker)
  const memoryStats = signal({ allocatedMB: 0, capacityMB: 0 });

  // User layer error (set when shader compilation fails)
  const userLayerState = signal<{ layerId: string; error: string } | 'ok' | null>(null);

  // Frame throttle state
  let lastRafTime = 0;
  let frameDebt = 0;

  function shouldRunFrame(rafTime: number): boolean {
    const fpsLimit = optionsService.options.value.debug.fpsLimit;
    if (fpsLimit === 'off') return true;
    const targetFrameTime = 1000 / parseInt(fpsLimit, 10);
    const delta = lastRafTime ? rafTime - lastRafTime : targetFrameTime;
    lastRafTime = rafTime;
    frameDebt += delta;
    if (frameDebt < targetFrameTime) return false;
    frameDebt = Math.min(frameDebt - targetFrameTime, targetFrameTime);
    return true;
  }

  // Perf stats
  const frameIntervals = createRollingAvg(60);
  const frameTimes = createRollingAvg(60);
  const pass1Times = createRollingAvg(60);
  const pass2Times = createRollingAvg(60);
  const pass3Times = createRollingAvg(60);
  let lastFrameTime = performance.now();
  let perfFrameCount = 0;

  // Camera (created in init)
  let camera: Camera | null = null;
  let viewport: { tick: () => void; setPosition: (lat: number, lon: number, distance: number) => void } | null = null;
  let canvas: HTMLCanvasElement | null = null;

  // Reusable buffers for render message (avoid GC pressure)
  const viewProjBuffer = new Float32Array(16);
  const viewProjInverseBuffer = new Float32Array(16);
  const eyeBuffer = new Float32Array(3);

  worker.onmessage = (e: MessageEvent<AuroraResponse>) => {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        onReady?.();
        break;
      case 'frameComplete':
        onFrameComplete?.(msg.timing, msg.memoryMB);
        if (frameCompleteResolve) {
          const resolve = frameCompleteResolve;
          frameCompleteResolve = null;
          resolve();
        }
        break;
      case 'error':
        console.error('[Aurora]', msg.message);
        break;
      case 'exportFrame':
        if (exportFrameResolve) {
          const resolve = exportFrameResolve;
          exportFrameResolve = null;
          resolve(msg.bitmap);
        } else {
          onExportFrame?.(msg.bitmap);
        }
        break;
      case 'recordProgress':
        onRecordProgress?.(msg.frameIndex);
        break;
      case 'recordBatchComplete':
        onRecordBatchComplete?.(msg.bitmaps);
        break;
      case 'userLayerResult':
        if (!msg.success && msg.error) {
          userLayerState.value = { layerId: msg.layerId, error: msg.error };
        } else {
          userLayerState.value = 'ok';
        }
        break;
    }
  };
  worker.onerror = (e) => console.error('[Aurora] Worker error:', e.message);

  function updatePerfStats(): void {
    if (++perfFrameCount % 10 !== 0) return;
    const intervalAvg = frameIntervals.avg();
    const fps = intervalAvg > 0 ? 1000 / intervalAvg : 0;
    perfService.setFps(fps);
    perfService.setFrameMs(frameTimes.avg());
    perfService.setPass1Ms(pass1Times.avg());
    perfService.setPass2Ms(pass2Times.avg());
    perfService.setPass3Ms(pass3Times.avg());
    perfService.setDropped(droppedFrames);
    if (camera && canvas) {
      const fov = 2 * Math.atan(camera.getTanFov());
      const globeRadiusPx = Math.asin(1 / camera.distance) * (canvas.clientHeight / fov);
      perfService.setGlobe(globeRadiusPx);
      perfService.setScreen(canvas.clientWidth, canvas.clientHeight);
    }
  }

  function send(msg: AuroraRequest, transfer?: Transferable[]): void {
    worker.postMessage(msg, transfer ?? []);  // QC-OK: postMessage API
  }

  return {
    async init(canvasEl: HTMLCanvasElement, config: AuroraConfig, assets: AuroraAssets): Promise<void> {
      canvas = canvasEl;
      const offscreen = canvas.transferControlToOffscreen();
      const downscale = parseInt(optionsService.options.value.debug.renderScale, 10);
      const width = Math.round(canvas.clientWidth * window.devicePixelRatio / downscale);
      const height = Math.round(canvas.clientHeight * window.devicePixelRatio / downscale);

      const transferables: Transferable[] = [
        offscreen,
        assets.atmosphereLUTs.transmittance,
        assets.atmosphereLUTs.scattering,
        assets.gaussianLats.buffer,
        assets.ringOffsets.buffer,
        ...assets.basemapFaces,
        assets.fontAtlas,
        assets.logo,
      ];

      await new Promise<void>((resolve) => {
        onReady = () => resolve();
        send({ type: 'init', canvas: offscreen, width, height, cssHeight: canvas!.clientHeight, dpr: window.devicePixelRatio, config, assets }, transferables);
      });

      // Create camera
      const cameraConfig = configService.getCameraConfig();
      camera = new Camera(undefined, cameraConfig);
      camera.setAspect(canvas.clientWidth, canvas.clientHeight);

      // Set up camera controls
      viewport = setupViewport(canvas, camera, stateService, configService, optionsService);

      // Send initial options (bulk legacy channel — shrinks per-layer as
      // typed-setter UI migration progresses).
      const initOpts = optionsService.options.value;
      send({ type: 'options', value: initOpts });

      // Sub-B Phase 5 UI migration: typed-setter dispatch for migrated layers.
      // Worker no longer mirrors these out of the bulk 'options' message.
      send({ type: 'setLayerOptions', id: 'graticule', opts: {
        fontSize: initOpts.graticule.fontSize,
        lineWidth: initOpts.graticule.lineWidth,
      } });
      send({ type: 'setLayerOptions', id: 'cities', opts: {
        color: CITY_COLORS_RGB[initOpts.cities.color],
      } });
      send({ type: 'setLayerOptions', id: 'wind', opts: {
        seedCount: initOpts.wind.seedCount,
        speed: initOpts.wind.speed,
      } });
      send({ type: 'setLayerOptions', id: 'pressure', opts: {
        spacing: parseInt(initOpts.pressure.spacing, 10),
        smoothing: initOpts.pressure.smoothing,
        colors: initOpts.pressure.colors,
      } });
      send({ type: 'setLayerOptions', id: 'rain', opts: {
        animated: initOpts.rain.animated,
      } });

      // Initial setLayerOpacity for every built-in. Host pre-multiplies the
      // toggle (enabled→0) so aurora gets one number per layer.
      for (const id of OPACITY_BUILT_INS) {
        const layerOpts = initOpts[id];
        send({ type: 'setLayerOpacity', id, value: layerOpts.enabled ? layerOpts.opacity : 0 });
      }

      // Forward options updates to worker
      let lastOptions = initOpts;
      const lastPalettes = new Map<string, string>();
      // Seed last palettes from initial options
      for (const [group, layerOpts] of Object.entries(lastOptions)) {
        if (hasPaletteField(layerOpts)) {
          lastPalettes.set(group, layerOpts.palette);
        }
      }
      effect(() => {
        const opts = optionsService.options.value;
        if (opts !== lastOptions) {
          // Check palette changes for any layer
          for (const [group, layerOpts] of Object.entries(opts)) {
            if (hasPaletteField(layerOpts) && layerOpts.palette !== lastPalettes.get(group)) {
              lastPalettes.set(group, layerOpts.palette);
              send({ type: 'updatePalette', layer: group, paletteId: layerOpts.palette });
            }
          }
          // Typed-setter dispatch for migrated layers (their fields are no
          // longer applied from the bulk channel on the worker side).
          if (opts.graticule !== lastOptions.graticule) {
            send({ type: 'setLayerOptions', id: 'graticule', opts: {
              fontSize: opts.graticule.fontSize,
              lineWidth: opts.graticule.lineWidth,
            } });
          }
          if (opts.cities.color !== lastOptions.cities.color) {
            send({ type: 'setLayerOptions', id: 'cities', opts: {
              color: CITY_COLORS_RGB[opts.cities.color],
            } });
          }
          if (opts.wind.seedCount !== lastOptions.wind.seedCount
            || opts.wind.speed !== lastOptions.wind.speed) {
            send({ type: 'setLayerOptions', id: 'wind', opts: {
              seedCount: opts.wind.seedCount,
              speed: opts.wind.speed,
            } });
          }
          if (opts.pressure.spacing !== lastOptions.pressure.spacing
            || opts.pressure.smoothing !== lastOptions.pressure.smoothing
            || opts.pressure.colors !== lastOptions.pressure.colors) {
            send({ type: 'setLayerOptions', id: 'pressure', opts: {
              spacing: parseInt(opts.pressure.spacing, 10),
              smoothing: opts.pressure.smoothing,
              colors: opts.pressure.colors,
            } });
          }
          if (opts.rain.animated !== lastOptions.rain.animated) {
            send({ type: 'setLayerOptions', id: 'rain', opts: {
              animated: opts.rain.animated,
            } });
          }
          // Dispatch setLayerOpacity per built-in when its enabled or opacity
          // changed. Host pre-multiplies enabled→0.
          for (const id of OPACITY_BUILT_INS) {
            const cur = opts[id];
            const prev = lastOptions[id];
            if (cur.enabled !== prev.enabled || cur.opacity !== prev.opacity) {
              send({ type: 'setLayerOpacity', id, value: cur.enabled ? cur.opacity : 0 });
            }
          }
          lastOptions = opts;
          send({ type: 'options', value: opts });
        }
      });

      // Handle resize
      const getDownscale = () => parseInt(optionsService.options.value.debug.renderScale, 10);
      const sendResize = () => {
        const d = getDownscale();
        const w = Math.round(canvas!.clientWidth * window.devicePixelRatio / d);
        const h = Math.round(canvas!.clientHeight * window.devicePixelRatio / d);
        camera!.setAspect(canvas!.clientWidth, canvas!.clientHeight);
        send({ type: 'resize', width: w, height: h, cssHeight: canvas!.clientHeight, dpr: window.devicePixelRatio });
        perfService.setScreen(canvas!.clientWidth, canvas!.clientHeight);
      };
      const resizeObserver = new ResizeObserver(sendResize);
      resizeObserver.observe(canvas);
      perfService.setScreen(canvas.clientWidth, canvas.clientHeight);

      // iOS standalone PWA resize handlers
      window.addEventListener('resize', sendResize);
      window.addEventListener('orientationchange', sendResize);

      // React to render scale option changes
      let lastDownscale = optionsService.options.value.debug.renderScale;
      effect(() => {
        const ds = optionsService.options.value.debug.renderScale;
        if (ds !== lastDownscale) {
          lastDownscale = ds;
          sendResize();
        }
      });

      // Cleanup handlers
      window.addEventListener('beforeunload', () => this.cleanup());
      window.addEventListener('pagehide', () => this.cleanup());

      // Debug hotkeys (localhost only)
      if (location.hostname === 'localhost') {
        window.addEventListener('keydown', (e) => {
          if (e.metaKey || e.ctrlKey) return;
          if (e.key === 'p') {
            paused = !paused;
            console.log(`[Aurora] Rendering ${paused ? 'PAUSED' : 'RESUMED'}`);
          }
          if (e.key === '1' || e.key === '2' || e.key === '4') {
            optionsService.update(d => { d.debug.renderScale = e.key as '1' | '2' | '4'; });
            console.log(`[Aurora] Render scale: ${e.key}x`);
          }
        });
      }
    },

    uploadData(param: string, slotIndex: number, data: Float32Array): void {
      send({ type: 'uploadData', param, slotIndex, data }, [data.buffer]);
    },

    activateSlots(param: string, slot0: number, slot1: number, t0: number, t1: number, loadedPoints?: number): void {
      if (loadedPoints !== undefined) {
        send({ type: 'activateSlots', param, slot0, slot1, t0, t1, loadedPoints });
      } else {
        send({ type: 'activateSlots', param, slot0, slot1, t0, t1 });
      }
    },

    deactivateSlots(param: string): void {
      send({ type: 'deactivateSlots', param });
    },

    updatePalette(layer: string, paletteId: PaletteId): void {
      send({ type: 'updatePalette', layer, paletteId });
    },

    setEngineOptions(patch: Partial<EngineOpts>): void {
      send({ type: 'setEngineOptions', patch });
    },

    setLayerOptions(id: string, opts: unknown): void {
      send({ type: 'setLayerOptions', id, opts });
    },

    setLayerOpacity(id: string, value: number): void {
      send({ type: 'setLayerOpacity', id, value });
    },

    start(): void {
      const cam = camera!;
      const controls = viewport!;

      onFrameComplete = (timing, memory) => {
        renderInFlight = false;
        frameTimes.push(timing.frame);
        pass1Times.push(timing.pass1);
        pass2Times.push(timing.pass2);
        pass3Times.push(timing.pass3);
        memoryStats.value = { allocatedMB: memory.allocated, capacityMB: memory.capacity };
      };

      const frame = (rafTime: number) => {
        if (shouldRunFrame(rafTime)) {
          const now = performance.now();
          frameIntervals.push(now - lastFrameTime);
          lastFrameTime = now;

          // --- UPDATE ---
          controls.tick();
          cam.update();
          updatePerfStats();

          // --- RENDER ---
          if (!paused && !recording && !renderInFlight) {
            renderInFlight = true;
            viewProjBuffer.set(cam.getViewProj());
            viewProjInverseBuffer.set(cam.getViewProjInverse());
            eyeBuffer.set(cam.getEyePosition());
            send({
              type: 'render',
              camera: {
                viewProj: viewProjBuffer,
                viewProjInverse: viewProjInverseBuffer,
                eye: eyeBuffer,
                tanFov: cam.getTanFov(),
              },
              time: stateService.viewState.value.time.getTime(),
            });
          } else if (!paused) {
            droppedFrames++;
          }
        }
        requestAnimationFrame(frame);
      };

      requestAnimationFrame(frame);
    },

    getCamera(): Camera {
      if (!camera) throw new Error('AuroraService.getCamera() called before init()');
      return camera;
    },

    setCameraPosition(lat: number, lon: number, distance: number): void {
      if (!viewport) throw new Error('AuroraService.setCameraPosition() called before init()');
      viewport.setPosition(lat, lon, distance);
    },

    memoryStats,
    userLayerState,

    get recording() { return recording; },
    set recording(v: boolean) { recording = v; },

    get onExportFrame() { return onExportFrame; },
    set onExportFrame(cb: ((bitmap: ImageBitmap) => void) | null) { onExportFrame = cb; },

    get onRecordProgress() { return onRecordProgress; },
    set onRecordProgress(cb: ((frameIndex: number) => void) | null) { onRecordProgress = cb; },

    get onRecordBatchComplete() { return onRecordBatchComplete; },
    set onRecordBatchComplete(cb: ((bitmaps: ImageBitmap[]) => void) | null) { onRecordBatchComplete = cb; },

    getCameraSnapshot() {
      const cam = camera!;
      return {
        viewProj: new Float32Array(cam.getViewProj()),
        viewProjInverse: new Float32Array(cam.getViewProjInverse()),
        eye: new Float32Array(cam.getEyePosition()),
        tanFov: cam.getTanFov(),
      };
    },

    waitForFrameComplete(): Promise<void> {
      return new Promise(resolve => {
        frameCompleteResolve = resolve;
      });
    },

    waitForExportFrame(): Promise<ImageBitmap> {
      return new Promise(resolve => {
        exportFrameResolve = resolve;
      });
    },

    resetPerfStats(): void {
      frameIntervals.clear();
      frameTimes.clear();
      pass1Times.clear();
      pass2Times.clear();
      pass3Times.clear();
      perfFrameCount = 0;
    },

    cleanup(): void {
      send({ type: 'cleanup' });
    },

    dispose(): void {
      this.cleanup();
      worker.terminate();
    },

    send,
  };
}
