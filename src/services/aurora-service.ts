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
import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets } from '../aurora/worker';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { OptionsService } from './options-service';
import type { PerfService } from './perf-service';
import type { PaletteService } from './palette-service';
import { Camera } from '../aurora/camera';
import { setupViewport } from './viewport/viewport';

// Re-export types for consumers
export type { AuroraConfig, AuroraAssets } from '../aurora/worker';
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
  updatePalette(layer: string, textureData: Uint8Array, range: [number, number]): void;
  getCamera(): Camera;
  setCameraPosition(lat: number, lon: number, distance: number): void;
  memoryStats: Signal<{ allocatedMB: number; capacityMB: number }>;
  userLayerError: Signal<{ layerId: string; error: string } | null>;
  send(msg: AuroraRequest, transfer?: Transferable[]): void;
}

export function createAuroraService(
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService,
  perfService: PerfService,
  paletteService?: PaletteService
): AuroraService {
  // Worker
  const worker = new Worker(
    new URL('../aurora/worker.ts', import.meta.url),
    { type: 'module', name: 'aurora' }
  );

  // Message callbacks
  let onReady: (() => void) | null = null;
  let onFrameComplete: ((timing: { frame: number; pass1: number; pass2: number; pass3: number }, memoryMB: { allocated: number; capacity: number }) => void) | null = null;

  // Render loop state
  let renderInFlight = false;
  let droppedFrames = 0;
  let paused = false;

  // GPU memory stats (updated each frame from worker)
  const memoryStats = signal({ allocatedMB: 0, capacityMB: 0 });

  // User layer error (set when shader compilation fails)
  const userLayerError = signal<{ layerId: string; error: string } | null>(null);

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
        break;
      case 'error':
        console.error('[Aurora]', msg.message);
        break;
      case 'userLayerResult':
        if (!msg.success && msg.error) {
          userLayerError.value = { layerId: msg.layerId, error: msg.error };
        } else {
          userLayerError.value = null;
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
    worker.postMessage(msg, transfer ?? []);
  }

  return {
    async init(canvasEl: HTMLCanvasElement, config: AuroraConfig, assets: AuroraAssets): Promise<void> {
      canvas = canvasEl;
      const offscreen = canvas.transferControlToOffscreen();
      const dpr = window.devicePixelRatio;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;

      const transferables: Transferable[] = [
        offscreen,
        assets.atmosphereLUTs.transmittance,
        assets.atmosphereLUTs.scattering,
        assets.atmosphereLUTs.irradiance,
        assets.gaussianLats.buffer,
        assets.ringOffsets.buffer,
        ...assets.basemapFaces,
        assets.fontAtlas,
        assets.logo,
      ];

      await new Promise<void>((resolve) => {
        onReady = () => resolve();
        send({ type: 'init', canvas: offscreen, width, height, config, assets }, transferables);
      });

      // Create camera
      const cameraConfig = configService.getCameraConfig();
      camera = new Camera(undefined, cameraConfig);
      camera.setAspect(canvas.clientWidth, canvas.clientHeight);

      // Set up camera controls
      viewport = setupViewport(canvas, camera, stateService, configService, optionsService);

      // Send initial options
      send({ type: 'options', value: optionsService.options.value });

      // Forward options updates to worker
      let lastOptions = optionsService.options.value;
      let lastTempPalette = lastOptions.temp.palette;
      effect(() => {
        const opts = optionsService.options.value;
        if (opts !== lastOptions) {
          // Check if temp palette changed
          if (paletteService && opts.temp.palette !== lastTempPalette) {
            lastTempPalette = opts.temp.palette;
            paletteService.setPalette('temp', opts.temp.palette);
            const palette = paletteService.getPalette('temp');
            const textureData = paletteService.generateTextureData(palette);
            const range = paletteService.getRange(palette);
            send({ type: 'updatePalette', layer: 'temp', textureData, range: [range.min, range.max] });
          }
          lastOptions = opts;
          send({ type: 'options', value: opts });
        }
      });

      // Handle resize
      const updateScreen = () => perfService.setScreen(canvas!.clientWidth, canvas!.clientHeight);
      const resizeObserver = new ResizeObserver(() => {
        const dpr = window.devicePixelRatio;
        const w = canvas!.clientWidth * dpr;
        const h = canvas!.clientHeight * dpr;
        camera!.setAspect(canvas!.clientWidth, canvas!.clientHeight);
        send({ type: 'resize', width: w, height: h });
        updateScreen();
      });
      resizeObserver.observe(canvas);
      updateScreen();

      // iOS standalone PWA resize handlers
      window.addEventListener('resize', () => {
        const dpr = window.devicePixelRatio;
        send({ type: 'resize', width: canvas!.clientWidth * dpr, height: canvas!.clientHeight * dpr });
      });
      window.addEventListener('orientationchange', () => {
        const dpr = window.devicePixelRatio;
        send({ type: 'resize', width: canvas!.clientWidth * dpr, height: canvas!.clientHeight * dpr });
      });

      // Cleanup handlers
      window.addEventListener('beforeunload', () => this.cleanup());
      window.addEventListener('pagehide', () => this.cleanup());

      // Debug: 'p' key pauses rendering (localhost only)
      if (location.hostname === 'localhost') {
        window.addEventListener('keydown', (e) => {
          if (e.key === 'p' && !e.metaKey && !e.ctrlKey) {
            paused = !paused;
            console.log(`[Aurora] Rendering ${paused ? 'PAUSED' : 'RESUMED'}`);
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

    updatePalette(layer: string, textureData: Uint8Array, range: [number, number]): void {
      send({ type: 'updatePalette', layer, textureData, range });
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
          if (!paused && !renderInFlight) {
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
    userLayerError,

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
