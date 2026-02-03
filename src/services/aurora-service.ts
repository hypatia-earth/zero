/**
 * Aurora Service - Bridge between main thread and Aurora GPU worker
 *
 * Handles:
 * - Worker lifecycle (creation, initialization, cleanup)
 * - Message passing with proper transferables
 * - Render loop coordination via requestAnimationFrame
 * - Perf panel updates
 */

import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets } from '../workers/aurora.worker';
import type { StateService } from './state-service';
import type { ZeroOptions } from '../schemas/options.schema';
import type { TWeatherLayer } from '../config/types';

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
  updateCamera(viewProj: Float32Array, viewProjInverse: Float32Array, eye: Float32Array, tanFov: number): void;
  updateOptions(options: ZeroOptions): void;
  uploadData(layer: TWeatherLayer, timestep: string, slotIndex: number, slabIndex: number, data: Float32Array): void;
  activateSlots(layer: TWeatherLayer, slot0: number, slot1: number, t0: number, t1: number, loadedPoints?: number): void;
  updatePalette(layer: 'temp', textureData: Uint8Array, min: number, max: number): void;
  triggerPressureRegrid(slotIndex: number): void;
  setUpdate(callback: () => void): void;
  start(): void;
  stop(): void;
  setOnPerfUpdate(callback: (stats: PerfStats) => void): void;
  resize(width: number, height: number): void;
  cleanup(): void;
  dispose(): void;
  send(msg: AuroraRequest, transfer?: Transferable[]): void;
  onMessage<T extends AuroraResponse['type']>(type: T, handler: (msg: Extract<AuroraResponse, { type: T }>) => void): void;
}

export function createAuroraService(stateService: StateService): AuroraService {
  // Worker
  const worker = new Worker(
    new URL('../workers/aurora.worker.ts', import.meta.url),
    { type: 'module', name: 'aurora' }
  );

  // Message handlers
  const handlers = new Map<AuroraResponse['type'], (msg: AuroraResponse) => void>();

  // Render loop state
  let animationId: number | null = null;
  let running = false;
  let renderInFlight = false;
  let droppedFrames = 0;

  // Perf stats
  const frameIntervals = createRollingAvg(60);
  const frameTimes = createRollingAvg(60);
  const passTimes = createRollingAvg(60);
  let lastFrameTime = 0;
  let frameStartTime = 0;
  let onPerfUpdate: ((stats: PerfStats) => void) | null = null;

  // Camera state for render messages
  const camera = {
    viewProj: new Float32Array(16),
    viewProjInverse: new Float32Array(16),
    eye: new Float32Array([0, 0, 3]),
    tanFov: Math.tan(Math.PI / 8),
  };

  // Update callback
  let update: () => void = () => {};

  // Handle incoming messages
  function handleMessage(msg: AuroraResponse): void {
    const handler = handlers.get(msg.type);
    if (handler) {
      handler(msg);
    }
    if (msg.type === 'error') {
      console.error('[Aurora]', msg.message, msg.fatal ? '(fatal)' : '');
    }
  }

  worker.onmessage = (e: MessageEvent<AuroraResponse>) => handleMessage(e.data);
  worker.onerror = (e) => console.error('[Aurora] Worker error:', e.message);

  function emitPerfStats(): void {
    if (!onPerfUpdate) return;
    const intervalAvg = frameIntervals.avg();
    onPerfUpdate({
      fps: intervalAvg > 0 ? 1000 / intervalAvg : 0,
      frameMs: frameTimes.avg(),
      passMs: passTimes.avg(),
      dropped: droppedFrames,
    });
  }

  function send(msg: AuroraRequest, transfer?: Transferable[]): void {
    worker.postMessage(msg, transfer ?? []);
  }

  return {
    async init(canvas: HTMLCanvasElement, config: AuroraConfig, assets: AuroraAssets): Promise<void> {
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

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Aurora worker init timeout')), 10000);

        handlers.set('ready', () => {
          clearTimeout(timeout);
          resolve();
        });
        handlers.set('error', (msg) => {
          if ('fatal' in msg && msg.fatal) {
            clearTimeout(timeout);
            reject(new Error('message' in msg ? msg.message : 'Unknown error'));
          }
        });

        send({ type: 'init', canvas: offscreen, width, height, config, assets }, transferables);
      });
    },

    updateCamera(viewProj: Float32Array, viewProjInverse: Float32Array, eye: Float32Array, tanFov: number): void {
      camera.viewProj.set(viewProj);
      camera.viewProjInverse.set(viewProjInverse);
      camera.eye.set(eye);
      camera.tanFov = tanFov;
    },

    updateOptions(options: ZeroOptions): void {
      send({ type: 'options', value: options });
    },

    uploadData(layer: TWeatherLayer, timestep: string, slotIndex: number, slabIndex: number, data: Float32Array): void {
      send({ type: 'uploadData', layer, timestep, slotIndex, slabIndex, data }, [data.buffer]);
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

    setUpdate(callback: () => void): void {
      update = callback;
    },

    start(): void {
      if (running) return;
      running = true;

      handlers.set('frameComplete', (msg) => {
        renderInFlight = false;
        frameTimes.push(performance.now() - frameStartTime);
        if ('timing' in msg && msg.timing?.frame) {
          passTimes.push(msg.timing.frame);
        }
        emitPerfStats();
      });

      const frame = () => {
        if (!running) return;

        const now = performance.now();
        if (lastFrameTime > 0) {
          frameIntervals.push(now - lastFrameTime);
        }
        lastFrameTime = now;

        update();

        if (!renderInFlight) {
          renderInFlight = true;
          frameStartTime = now;
          send({
            type: 'render',
            camera: {
              viewProj: new Float32Array(camera.viewProj),
              viewProjInverse: new Float32Array(camera.viewProjInverse),
              eye: new Float32Array(camera.eye),
              tanFov: camera.tanFov,
            },
            time: stateService.viewState.value.time.getTime(),
          });
        } else {
          droppedFrames++;
        }

        animationId = requestAnimationFrame(frame);
      };

      animationId = requestAnimationFrame(frame);
    },

    stop(): void {
      running = false;
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    },

    setOnPerfUpdate(callback: (stats: PerfStats) => void): void {
      onPerfUpdate = callback;
    },

    resize(width: number, height: number): void {
      send({ type: 'resize', width, height });
    },

    cleanup(): void {
      this.stop();
      send({ type: 'cleanup' });
    },

    dispose(): void {
      this.cleanup();
      worker.terminate();
    },

    send,

    onMessage<T extends AuroraResponse['type']>(type: T, handler: (msg: Extract<AuroraResponse, { type: T }>) => void): void {
      handlers.set(type, handler as (msg: AuroraResponse) => void);
    },
  };
}
