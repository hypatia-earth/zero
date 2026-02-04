/**
 * Aurora Service - Bridge between main thread and Aurora GPU worker
 *
 * Handles:
 * - Worker lifecycle (creation, initialization, cleanup)
 * - Message passing with proper transferables
 * - Render loop coordination via requestAnimationFrame
 * - Perf panel updates
 */

import { effect } from '@preact/signals-core';
import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets } from '../workers/aurora.worker';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { OptionsService } from './options-service';
import type { PerfService } from './perf-service';
import type { TWeatherLayer } from '../config/types';
import { Camera } from '../render/camera';
import { setupCameraControls } from './camera-controls';

// Re-export types for consumers
export type { AuroraConfig, AuroraAssets } from '../workers/aurora.worker';

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
  uploadData(layer: TWeatherLayer, slotIndex: number, slabIndex: number, data: Float32Array): void;
  activateSlots(layer: TWeatherLayer, slot0: number, slot1: number, t0: number, t1: number, loadedPoints?: number): void;
  updatePalette(layer: 'temp', textureData: Uint8Array, min: number, max: number): void;
  triggerPressureRegrid(slotIndex: number): void;
  getCamera(): Camera;
  send(msg: AuroraRequest, transfer?: Transferable[]): void;
}

export function createAuroraService(
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService,
  perfService: PerfService
): AuroraService {
  // Worker
  const worker = new Worker(
    new URL('../workers/aurora.worker.ts', import.meta.url),
    { type: 'module', name: 'aurora' }
  );

  // Message callbacks
  let onReady: (() => void) | null = null;
  let onFrameComplete: ((timing: { frame: number; pass: number }) => void) | null = null;

  // Render loop state
  let renderInFlight = false;
  let droppedFrames = 0;

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
  const passTimes = createRollingAvg(60);
  let lastFrameTime = performance.now();
  let perfFrameCount = 0;

  // Camera (created in init)
  let camera: Camera | null = null;
  let cameraControls: { tick: () => void } | null = null;
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
        onFrameComplete?.(msg.timing);
        break;
      case 'error':
        console.error('[Aurora]', msg.message);
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
    perfService.setPassMs(passTimes.avg());
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
      cameraControls = setupCameraControls(canvas, camera, stateService, configService, optionsService);

      // Send initial options
      send({ type: 'options', value: optionsService.options.value });

      // Forward options updates to worker
      let lastOptions = optionsService.options.value;
      effect(() => {
        const opts = optionsService.options.value;
        if (opts !== lastOptions) {
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
    },

    uploadData(layer: TWeatherLayer, slotIndex: number, slabIndex: number, data: Float32Array): void {
      send({ type: 'uploadData', layer, slotIndex, slabIndex, data }, [data.buffer]);
    },

    activateSlots(layer: TWeatherLayer, slot0: number, slot1: number, t0: number, t1: number, loadedPoints?: number): void {
      if (loadedPoints !== undefined) {
        send({ type: 'activateSlots', layer, slot0, slot1, t0, t1, loadedPoints });
      } else {
        send({ type: 'activateSlots', layer, slot0, slot1, t0, t1 });
      }
    },

    updatePalette(layer: 'temp', textureData: Uint8Array, min: number, max: number): void {
      send({ type: 'updatePalette', layer, textureData, min, max }, [textureData.buffer]);
    },

    triggerPressureRegrid(slotIndex: number): void {
      send({ type: 'triggerPressureRegrid', slotIndex });
    },

    start(): void {
      const cam = camera!;
      const controls = cameraControls!;

      onFrameComplete = (timing) => {
        renderInFlight = false;
        frameTimes.push(timing.frame);
        passTimes.push(timing.pass);
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
          if (!renderInFlight) {
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
          } else {
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
