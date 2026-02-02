/**
 * AuroraProxy - Bridge between main thread and Aurora GPU worker
 *
 * Handles:
 * - Worker lifecycle (creation, initialization, cleanup)
 * - Message passing with proper transferables
 * - Render loop coordination via requestAnimationFrame
 */

import type { AuroraRequest, AuroraResponse, AuroraConfig, AuroraAssets } from '../workers/aurora.worker';

// Re-export types for consumers
export type { AuroraConfig, AuroraAssets } from '../workers/aurora.worker';

export class AuroraProxy {
  private worker: Worker;
  private handlers = new Map<AuroraResponse['type'], (msg: AuroraResponse) => void>();
  private animationId: number | null = null;
  private running = false;

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
  updateCamera(viewProjInverse: Float32Array, eye: Float32Array, tanFov: number): void {
    // Clone buffers to avoid issues with transferring typed array views
    this.send({
      type: 'camera',
      viewProjInverse: new Float32Array(viewProjInverse),
      eye: new Float32Array(eye),
      tanFov,
    });
  }

  /**
   * Update palette texture
   */
  updatePalette(layer: 'temp', textureData: Uint8Array, min: number, max: number): void {
    this.send({ type: 'updatePalette', layer, textureData, min, max }, [textureData.buffer]);
  }

  /**
   * Start render loop
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Set up frame callback
    this.handlers.set('frameComplete', () => {
      if (this.running) {
        this.animationId = requestAnimationFrame(() => {
          this.send({ type: 'render' });
        });
      }
    });

    // Kick off first frame
    this.send({ type: 'render' });
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
