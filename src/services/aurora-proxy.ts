/**
 * AuroraProxy - Bridge between main thread and Aurora GPU worker
 *
 * Handles:
 * - Worker lifecycle (creation, initialization, cleanup)
 * - Message passing with proper transferables
 * - Render loop coordination via requestAnimationFrame
 * - Perf panel updates
 */

import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets } from '../workers/aurora.worker';

// Re-export types for consumers
export type { AuroraConfig, AuroraAssets } from '../workers/aurora.worker';

/** Performance statistics emitted each frame */
export interface PerfStats {
  fps: number;
  frameMs: number;
  passMs: number;
}

/** Simple rolling average for perf stats */
class RollingAvg {
  private values: number[] = [];
  constructor(private size: number) {}
  push(v: number) {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
  }
  avg(): number {
    if (this.values.length === 0) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
}

export class AuroraProxy {
  private worker: Worker;
  private handlers = new Map<AuroraResponse['type'], (msg: AuroraResponse) => void>();
  private animationId: number | null = null;
  private running = false;

  // Perf stats
  private frameIntervals = new RollingAvg(60);
  private frameTimes = new RollingAvg(60);
  private passTimes = new RollingAvg(60);
  private lastFrameTime = 0;
  private frameStartTime = 0;
  private onPerfUpdate: ((stats: PerfStats) => void) | null = null;

  constructor() {
    this.worker = new Worker(
      new URL('../workers/aurora.worker.ts', import.meta.url),
      { type: 'module', name: 'aurora' }
    );
    this.worker.onmessage = (e: MessageEvent<AuroraResponse>) => {
      this.handleMessage(e.data);
    };
    this.worker.onerror = (e) => {
      console.error('[AuroraProxy] Worker error:', e.message);
    };
  }

  /**
   * Initialize worker with canvas, config, and assets
   */
  async init(canvas: HTMLCanvasElement, config: AuroraConfig, assets: AuroraAssets): Promise<void> {
    const offscreen = canvas.transferControlToOffscreen();
    const dpr = window.devicePixelRatio;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;

    // Build transferables list (ownership moves to worker)
    const transferables: Transferable[] = [
      offscreen,
      // Atmosphere LUTs
      assets.atmosphereLUTs.transmittance,
      assets.atmosphereLUTs.scattering,
      assets.atmosphereLUTs.irradiance,
      // Gaussian LUTs (transfer underlying buffer)
      assets.gaussianLats.buffer,
      assets.ringOffsets.buffer,
      // ImageBitmaps (transferable in modern browsers)
      ...assets.basemapFaces,
      assets.fontAtlas,
      assets.logo,
    ];

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Aurora worker init timeout'));
      }, 10000);

      this.handlers.set('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.handlers.set('error', (msg) => {
        if ('fatal' in msg && msg.fatal) {
          clearTimeout(timeout);
          reject(new Error('message' in msg ? msg.message : 'Unknown error'));
        }
      });

      this.send({ type: 'init', canvas: offscreen, width, height, config, assets }, transferables);
    });
  }

  /**
   * Update camera state
   * Call this when camera changes (from CameraControls)
   */
  updateCamera(viewProj: Float32Array, viewProjInverse: Float32Array, eye: Float32Array, tanFov: number): void {
    // Clone buffers to avoid issues with transferring typed array views
    this.send({
      type: 'camera',
      viewProj: new Float32Array(viewProj),
      viewProjInverse: new Float32Array(viewProjInverse),
      eye: new Float32Array(eye),
      tanFov,
    });
  }

  /**
   * Update options
   * Call this when user changes settings
   */
  updateOptions(options: import('../schemas/options.schema').ZeroOptions): void {
    this.send({ type: 'options', value: options });
  }

  /**
   * Update current time
   * Call this when view time changes
   */
  updateTime(time: Date): void {
    this.send({ type: 'time', value: time.getTime() });
  }

  /**
   * Upload weather data to worker
   * Data is transferred (not copied) for efficiency
   */
  uploadData(
    layer: import('../config/types').TWeatherLayer,
    timestep: string,
    slotIndex: number,
    slabIndex: number,
    data: Float32Array
  ): void {
    this.send(
      { type: 'uploadData', layer, timestep, slotIndex, slabIndex, data },
      [data.buffer]  // Transfer ownership
    );
  }

  /**
   * Activate slots for rendering
   * Tells worker which slots to use for interpolation
   * @param t0 Unix timestamp of slot0
   * @param t1 Unix timestamp of slot1
   */
  activateSlots(
    layer: import('../config/types').TWeatherLayer,
    slot0: number,
    slot1: number,
    t0: number,
    t1: number,
    loadedPoints?: number
  ): void {
    // Only include loadedPoints if defined
    if (loadedPoints !== undefined) {
      this.send({ type: 'activateSlots', layer, slot0, slot1, t0, t1, loadedPoints });
    } else {
      this.send({ type: 'activateSlots', layer, slot0, slot1, t0, t1 });
    }
  }

  /**
   * Update palette texture
   */
  updatePalette(layer: 'temp', textureData: Uint8Array, min: number, max: number): void {
    this.send({ type: 'updatePalette', layer, textureData, min, max }, [textureData.buffer]);
  }

  /**
   * Trigger pressure regrid for a slot
   */
  triggerPressureRegrid(slotIndex: number): void {
    this.send({ type: 'triggerPressureRegrid', slotIndex });
  }

  private onBeforeRender: (() => void) | null = null;

  /**
   * Set callback to run before each render frame
   * Use this to forward camera state updates
   */
  setOnBeforeRender(callback: () => void): void {
    this.onBeforeRender = callback;
  }

  /**
   * Start render loop
   * Single synchronized loop: RAF → physics → camera → render → wait frameComplete → repeat
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    const frame = () => {
      if (!this.running) return;

      // Track frame interval
      const now = performance.now();
      if (this.lastFrameTime > 0) {
        this.frameIntervals.push(now - this.lastFrameTime);
      }
      this.lastFrameTime = now;
      this.frameStartTime = now;

      this.onBeforeRender?.();
      this.send({ type: 'render' });
    };

    // Wait for frameComplete before scheduling next frame
    this.handlers.set('frameComplete', (msg) => {
      if (this.running) {
        // Track frame time
        this.frameTimes.push(performance.now() - this.frameStartTime);

        // Track GPU pass time from worker
        if ('timing' in msg && msg.timing?.frame) {
          this.passTimes.push(msg.timing.frame);
        }

        // Emit perf stats
        this.emitPerfStats();

        this.animationId = requestAnimationFrame(frame);
      }
    });

    // Kick off first frame
    this.animationId = requestAnimationFrame(frame);
  }

  /**
   * Stop render loop
   */
  stop(): void {
    this.running = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Set callback for perf stats updates (called each frame)
   */
  setOnPerfUpdate(callback: (stats: PerfStats) => void): void {
    this.onPerfUpdate = callback;
  }

  private emitPerfStats(): void {
    if (!this.onPerfUpdate) return;

    const intervalAvg = this.frameIntervals.avg();
    this.onPerfUpdate({
      fps: intervalAvg > 0 ? 1000 / intervalAvg : 0,
      frameMs: this.frameTimes.avg(),
      passMs: this.passTimes.avg(),
    });
  }

  /**
   * Handle resize
   */
  resize(width: number, height: number): void {
    this.send({ type: 'resize', width, height });
  }

  /**
   * Clean up worker resources
   */
  cleanup(): void {
    this.stop();
    this.send({ type: 'cleanup' });
  }

  /**
   * Terminate worker completely
   */
  dispose(): void {
    this.cleanup();
    this.worker.terminate();
  }

  /**
   * Send message to worker
   */
  send(msg: AuroraRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  /**
   * Register message handler
   */
  onMessage<T extends AuroraResponse['type']>(
    type: T,
    handler: (msg: Extract<AuroraResponse, { type: T }>) => void
  ): void {
    this.handlers.set(type, handler as (msg: AuroraResponse) => void);
  }

  private handleMessage(msg: AuroraResponse): void {
    const handler = this.handlers.get(msg.type);
    if (handler) {
      handler(msg);
    }
    // Log errors
    if (msg.type === 'error') {
      console.error('[Aurora]', msg.message, msg.fatal ? '(fatal)' : '');
    }
  }
}
