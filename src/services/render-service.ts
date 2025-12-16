/**
 * RenderService - Manages renderer and render loop
 */

import { GlobeRenderer } from '../render/globe-renderer';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import type { ZeroOptions } from '../schemas/options.schema';
import { getSunDirection } from '../utils/sun-position';

export class RenderService {
  private renderer: GlobeRenderer | null = null;
  private animationId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tempLoadedPoints = 0;
  private tempSlot0 = 0;  // Current active slot indices
  private tempSlot1 = 1;
  private tempLerpFn: ((time: Date) => number) | null = null;
  private tempPaletteRange: Float32Array = new Float32Array([-40, 50]); // Default range

  constructor(
    private canvas: HTMLCanvasElement,
    private optionsService: OptionsService,
    private configService: ConfigService
  ) {}

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.renderer?.resize();
    });
    this.resizeObserver.observe(this.canvas);
  }

  async initialize(gaussianLats: Float32Array, ringOffsets: Uint32Array): Promise<void> {
    const cameraConfig = this.configService.getCameraConfig();
    this.renderer = new GlobeRenderer(this.canvas, cameraConfig);

    // Get slots per layer from user options
    const slotsPerLayer = parseInt(this.optionsService.options.value.gpu.slotsPerLayer, 10);
    const maxSlots = slotsPerLayer;

    await this.renderer.initialize(maxSlots);

    // Upload pre-computed Gaussian LUTs (O1280 grid)
    this.renderer.uploadGaussianLUTs(gaussianLats, ringOffsets);
  }

  getRenderer(): GlobeRenderer {
    if (!this.renderer) {
      throw new Error('RenderService not initialized');
    }
    return this.renderer;
  }

  start(): void {
    if (this.animationId !== null) return;
    if (!this.renderer) {
      throw new Error('RenderService not initialized');
    }

    this.setupResizeObserver();
    const renderer = this.renderer;

    const render = () => {
      this.animationId = requestAnimationFrame(render);

      const options = this.optionsService.options.value;
      const time = options.viewState.time;
      const rawLerp = this.tempLerpFn ? this.tempLerpFn(time) : -1;

      renderer.updateUniforms({
        ...this.getCameraUniforms(renderer),
        ...this.getSunUniforms(options, time),
        ...this.getGridUniforms(options),
        ...this.getLayerUniforms(options),
        ...this.getTempUniforms(options, rawLerp),
        ...this.getRainUniforms(options),
      });

      renderer.render();
    };

    render();
  }

  private getCameraUniforms(renderer: GlobeRenderer) {
    return {
      viewProjInverse: renderer.camera.getViewProjInverse(),
      eyePosition: renderer.camera.getEyePosition(),
      resolution: new Float32Array([this.canvas.width, this.canvas.height]),
      tanFov: renderer.camera.getTanFov(),
      time: performance.now() / 1000,
    };
  }

  private getSunUniforms(options: ZeroOptions, time: Date) {
    const cfg = this.configService.getConfig().sun;
    return {
      sunEnabled: options.sun.enabled,
      sunDirection: getSunDirection(time),
      sunCoreRadius: cfg.coreRadius,
      sunGlowRadius: cfg.glowRadius,
      sunCoreColor: new Float32Array(cfg.coreColor),
      sunGlowColor: new Float32Array(cfg.glowColor),
    };
  }

  private getGridUniforms(options: ZeroOptions) {
    return {
      gridEnabled: options.grid.enabled,
      gridOpacity: options.grid.opacity,
      gridFontSize: options.grid.fontSize,
    };
  }

  private getLayerUniforms(options: ZeroOptions) {
    return {
      earthOpacity: options.earth.enabled ? options.earth.opacity : 0,
    };
  }

  private getTempUniforms(options: ZeroOptions, rawLerp: number) {
    const tempEnabled = options.temp.enabled;
    const tempDataValid = rawLerp >= -2 && rawLerp !== -1 && this.tempLoadedPoints > 0;
    return {
      tempOpacity: tempEnabled ? options.temp.opacity : 0,
      tempDataReady: tempDataValid,
      tempLerp: rawLerp < 0 ? 0 : rawLerp,
      tempLoadedPoints: this.tempLoadedPoints,
      tempSlot0: this.tempSlot0,
      tempSlot1: this.tempSlot1,
      tempPaletteRange: this.tempPaletteRange,
    };
  }

  private getRainUniforms(options: ZeroOptions) {
    return {
      rainOpacity: options.rain.enabled ? options.rain.opacity : 0,
      rainDataReady: false,
    };
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  setTempLoadedPoints(points: number): void {
    this.tempLoadedPoints = points;
  }

  getTempLoadedPoints(): number {
    return this.tempLoadedPoints;
  }

  /**
   * Set active slot indices for temperature interpolation
   */
  setTempSlots(slot0: number, slot1: number): void {
    this.tempSlot0 = slot0;
    this.tempSlot1 = slot1;
  }

  getTempSlots(): { slot0: number; slot1: number } {
    return { slot0: this.tempSlot0, slot1: this.tempSlot1 };
  }

  /**
   * Set the function to calculate temp lerp (from BudgetService)
   */
  setTempLerpFn(fn: (time: Date) => number): void {
    this.tempLerpFn = fn;
  }

  /**
   * Update temperature palette texture
   */
  updateTempPalette(textureData: Uint8Array<ArrayBuffer>, min: number, max: number): void {
    if (!this.renderer) {
      throw new Error('RenderService not initialized');
    }
    this.renderer.updateTempPalette(textureData);
    this.tempPaletteRange = new Float32Array([min, max]);
    console.log(`[RenderService] Updated temp palette range: [${min}, ${max}]`);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
