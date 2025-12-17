/**
 * RenderService - Manages renderer and render loop
 */

import { GlobeRenderer } from '../render/globe-renderer';
import { ISOBAR_CONFIG } from '../render/pressure-layer';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import type { ZeroOptions } from '../schemas/options.schema';
import type { TParam } from '../config/types';
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

  // Animated opacity state (lerps toward target each frame)
  private lastFrameTime = 0;
  private animatedOpacity = {
    sun: 0,
    grid: 0,
    earth: 0,
    temp: 0,
    rain: 0,
    pressure: 0,
  };

  // Pressure layer state
  private pressureDataLoaded = false;

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

    // Get pressure resolution from options (1 or 2 degrees)
    const pressureResolution = parseInt(this.optionsService.options.value.pressure.resolution, 10) as 1 | 2;

    await this.renderer.initialize(maxSlots, pressureResolution);

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

      // Update animated opacities
      const now = performance.now() / 1000;
      const dt = this.lastFrameTime ? now - this.lastFrameTime : 0;
      this.lastFrameTime = now;
      this.updateAnimatedOpacities(options, rawLerp, dt);

      renderer.updateUniforms({
        ...this.getCameraUniforms(renderer),
        ...this.getSunUniforms(time),
        ...this.getGridUniforms(),
        ...this.getLayerUniforms(),
        ...this.getTempUniforms(rawLerp),
        ...this.getRainUniforms(),
        ...this.getPressureUniforms(),
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

  private getSunUniforms(time: Date) {
    const cfg = this.configService.getConfig().sun;
    return {
      sunOpacity: this.animatedOpacity.sun,
      sunDirection: getSunDirection(time),
      sunCoreRadius: cfg.coreRadius,
      sunGlowRadius: cfg.glowRadius,
      sunCoreColor: new Float32Array(cfg.coreColor),
      sunGlowColor: new Float32Array(cfg.glowColor),
    };
  }

  private getGridUniforms() {
    return {
      gridEnabled: this.animatedOpacity.grid > 0.01,  // Animated boolean
      gridOpacity: this.animatedOpacity.grid,
      gridFontSize: this.optionsService.options.value.grid.fontSize,
    };
  }

  private getLayerUniforms() {
    return {
      earthOpacity: this.animatedOpacity.earth,
    };
  }

  private getTempUniforms(rawLerp: number) {
    const tempDataValid = rawLerp >= -2 && rawLerp !== -1 && this.tempLoadedPoints > 0;
    return {
      tempOpacity: this.animatedOpacity.temp,
      tempDataReady: tempDataValid,
      tempLerp: rawLerp === -1 ? 0 : rawLerp,  // -2 = single slot mode (no interpolation)
      tempLoadedPoints: this.tempLoadedPoints,
      tempSlot0: this.tempSlot0,
      tempSlot1: this.tempSlot1,
      tempPaletteRange: this.tempPaletteRange,
    };
  }

  private getRainUniforms() {
    return {
      rainOpacity: this.animatedOpacity.rain,
      rainDataReady: false,
    };
  }

  private getPressureUniforms() {
    return {
      pressureOpacity: this.animatedOpacity.pressure,
    };
  }

  /**
   * Update animated opacities toward targets (called each frame)
   * Uses exponential decay for smooth ~100ms transitions
   */
  private updateAnimatedOpacities(options: ZeroOptions, rawLerp: number, dt: number): void {
    const animMs = this.configService.getConfig().render.opacityAnimationMs;
    const rate = 1000 / animMs;  // Convert ms to rate (e.g., 100ms → 10/s)
    const factor = Math.min(1, dt * rate);

    // Compute targets: enabled && (dataReady for data layers) ? userOpacity : 0
    const tempDataReady = rawLerp >= -2 && rawLerp !== -1 && this.tempLoadedPoints > 0;
    const targets = {
      sun: options.sun.enabled ? options.sun.opacity : 0,
      grid: options.grid.enabled ? options.grid.opacity : 0,
      earth: options.earth.enabled ? options.earth.opacity : 0,
      temp: (options.temp.enabled && tempDataReady) ? options.temp.opacity : 0,
      rain: options.rain.enabled ? options.rain.opacity : 0,  // TODO: add rainDataReady
      pressure: (options.pressure.enabled && this.pressureDataLoaded) ? options.pressure.opacity : 0,
    };

    // Lerp each toward target
    for (const key of Object.keys(this.animatedOpacity) as (keyof typeof this.animatedOpacity)[]) {
      this.animatedOpacity[key] += (targets[key] - this.animatedOpacity[key]) * factor;
    }
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
  }

  /**
   * Upload pressure data to slot 0 (backwards compat)
   * @deprecated Use uploadToSlot with slotIndex instead
   */
  uploadPressureData(data: Float32Array): void {
    this.uploadToSlot('pressure', data, 0);
  }

  /**
   * Check if pressure data is loaded
   */
  isPressureDataLoaded(): boolean {
    return this.pressureDataLoaded;
  }

  // ============================================================
  // Generic slot methods (called by SlotService)
  // ============================================================

  /**
   * Upload data to a slot for a given param
   * Routes to param-specific upload method
   */
  uploadToSlot(param: TParam, data: Float32Array, slotIndex: number): void {
    if (!this.renderer) {
      throw new Error('RenderService not initialized');
    }

    switch (param) {
      case 'temp':
        this.renderer.uploadTempDataToSlot(data, slotIndex);
        break;
      case 'pressure':
        // Upload to raw slot and trigger regrid
        this.renderer.uploadPressureDataToSlot(data, slotIndex);
        this.pressureDataLoaded = true;
        break;
      case 'rain':
      case 'wind':
        // TODO: implement when these layers support slots
        console.warn(`[RenderService] uploadToSlot not implemented for ${param}`);
        break;
    }
  }

  /**
   * Activate slots for a given param (shader will use these slots)
   * Routes to param-specific activation
   */
  activateSlots(param: TParam, slot0: number, slot1: number, loadedPoints: number): void {
    switch (param) {
      case 'temp':
        this.tempSlot0 = slot0;
        this.tempSlot1 = slot1;
        this.tempLoadedPoints = loadedPoints;
        break;
      case 'pressure':
        // Run contour compute with both grid slots
        // For now, lerp=0 (use slot0 only until interpolation is wired up)
        this.renderer?.runPressureContour(slot0, slot1, 0, [...ISOBAR_CONFIG.levels]);
        break;
      case 'rain':
      case 'wind':
        // TODO: implement when these layers support slots
        break;
    }
  }

  /**
   * Get max slots per layer from options
   */
  getMaxSlotsPerLayer(): number {
    return parseInt(this.optionsService.options.value.gpu.slotsPerLayer, 10);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
