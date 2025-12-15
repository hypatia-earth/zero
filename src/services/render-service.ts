/**
 * RenderService - Manages renderer and render loop
 */

import { GlobeRenderer } from '../render/globe-renderer';
import { generateGaussianLUTs } from '../render/gaussian-grid';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { LayerId } from '../config/types';
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

  constructor(
    private canvas: HTMLCanvasElement,
    private optionsService: OptionsService,
    private stateService: StateService,
    private configService: ConfigService
  ) {}

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.renderer?.resize();
    });
    this.resizeObserver.observe(this.canvas);
  }

  async initialize(): Promise<void> {
    const cameraConfig = this.configService.getCameraConfig();
    this.renderer = new GlobeRenderer(this.canvas, cameraConfig);

    // Get slots per layer from user options
    const slotsPerLayer = parseInt(this.optionsService.options.value.gpu.slotsPerLayer, 10);
    const maxSlots = slotsPerLayer;

    await this.renderer.initialize(maxSlots);

    // Upload Gaussian LUTs
    const luts = generateGaussianLUTs();
    this.renderer.uploadGaussianLUTs(luts.lats, luts.offsets);
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
      const state = this.stateService.get();
      const rawLerp = this.tempLerpFn ? this.tempLerpFn(state.time) : -1;

      renderer.updateUniforms({
        ...this.getCameraUniforms(renderer),
        ...this.getSunUniforms(state.layers, state.time),
        ...this.getGridUniforms(state.layers, options),
        ...this.getLayerUniforms(state.layers, options),
        ...this.getTempUniforms(state.layers, options, rawLerp),
        ...this.getRainUniforms(state.layers, options),
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

  private getSunUniforms(layers: LayerId[], time: Date) {
    const cfg = this.configService.getConfig().sun;
    return {
      sunEnabled: layers.includes('sun'),
      sunDirection: getSunDirection(time),
      sunCoreRadius: cfg.coreRadius,
      sunGlowRadius: cfg.glowRadius,
      sunCoreColor: new Float32Array(cfg.coreColor),
      sunGlowColor: new Float32Array(cfg.glowColor),
    };
  }

  private getGridUniforms(layers: LayerId[], options: ZeroOptions) {
    return {
      gridEnabled: layers.includes('grid'),
      gridOpacity: options.grid.opacity,
      gridFontSize: options.grid.fontSize,
    };
  }

  private getLayerUniforms(layers: LayerId[], options: ZeroOptions) {
    return {
      earthOpacity: layers.includes('earth') ? options.earth.opacity : 0,
    };
  }

  private getTempUniforms(layers: LayerId[], options: ZeroOptions, rawLerp: number) {
    const tempEnabled = layers.includes('temp');
    const tempDataValid = rawLerp >= -2 && rawLerp !== -1 && this.tempLoadedPoints > 0;
    return {
      tempOpacity: tempEnabled ? options.temp.opacity : 0,
      tempDataReady: tempDataValid,
      tempLerp: rawLerp < 0 ? 0 : rawLerp,
      tempLoadedPoints: this.tempLoadedPoints,
      tempSlot0: this.tempSlot0,
      tempSlot1: this.tempSlot1,
    };
  }

  private getRainUniforms(layers: LayerId[], options: ZeroOptions) {
    return {
      rainOpacity: layers.includes('rain') ? options.rain.opacity : 0,
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

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
