/**
 * RenderService - Manages renderer and render loop
 */

import { effect } from '@preact/signals-core';
import { GlobeRenderer } from '../render/globe-renderer';
import { generateIsobarLevels } from '../render/pressure-layer';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import type { ZeroOptions } from '../schemas/options.schema';
import { DECORATION_LAYERS, WEATHER_LAYERS, type TLayer, type TWeatherLayer, type TWeatherTextureLayer } from '../config/types';
import { getSunDirection } from '../utils/sun-position';
import { createRingBuffer, type RingBuffer } from '../utils/ringbuffer';

export class RenderService {
  private renderer: GlobeRenderer | null = null;
  private animationId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tempLoadedPoints = 0;
  private tempSlot0 = 0;  // Current active slot indices
  private tempSlot1 = 1;
  private tempLerpFn: ((time: Date) => number) | null = null;
  private tempPaletteRange: Float32Array = new Float32Array([-40, 50]); // Default range

  // Pressure contour state
  private pressureSlot0 = 0;
  private pressureSlot1 = 0;
  private pressureLerpFn: ((time: Date) => number) | null = null;
  private lastPressureLerp = -1;  // For change detection
  private isobarLevels: number[] = generateIsobarLevels(4);  // Default spacing

  // Animated opacity state (lerps toward target each frame)
  private lastFrameTime = 0;
  private animatedOpacity: Record<TLayer, number> = Object.fromEntries(
    [...DECORATION_LAYERS, ...WEATHER_LAYERS].map(layer => [layer, 0])
  ) as Record<TLayer, number>;

  // Data-ready functions per param (provided by SlotService)
  private dataReadyFns = new Map<TWeatherLayer, () => boolean>();

  // Callback when pressure resolution changes (slots needing regrid)
  private onPressureResolutionChange: ((slotsNeedingRegrid: number[]) => void) | null = null;

  // Frame timing (60-frame rolling average)
  private frameTimes: RingBuffer = createRingBuffer(60);
  private passTimes: RingBuffer = createRingBuffer(60);
  private perfFrameElement: HTMLElement | null = null;
  private perfPassElement: HTMLElement | null = null;
  private perfScreenElement: HTMLElement | null = null;
  private perfGlobeElement: HTMLElement | null = null;

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

    // Get timeslots per layer from user options
    const timeslotsPerLayer = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

    // Get pressure resolution from options (1 or 2 degrees)
    const resolutionMap = { '1': 1, '2': 2 } as const;
    const pressureResolution = resolutionMap[this.optionsService.options.value.pressure.resolution];

    await this.renderer.initialize(timeslotsPerLayer, pressureResolution);

    // Upload pre-computed Gaussian LUTs (O1280 grid)
    this.renderer.uploadGaussianLUTs(gaussianLats, ringOffsets);

    // Listen for pressure resolution changes (live update)
    let lastResolution = pressureResolution;
    effect(() => {
      const newResolution = resolutionMap[this.optionsService.options.value.pressure.resolution];
      if (newResolution !== lastResolution) {
        lastResolution = newResolution;
        const slotsNeedingRegrid = this.renderer?.setPressureResolution(newResolution) ?? [];
        this.lastPressureLerp = -1;  // Force contour recompute on next frame
        if (slotsNeedingRegrid.length > 0) {
          this.onPressureResolutionChange?.(slotsNeedingRegrid);
        }
      }
    });

    // Listen for pressure spacing changes (live update)
    let lastSpacing = parseInt(this.optionsService.options.value.pressure.spacing, 10);
    this.isobarLevels = generateIsobarLevels(lastSpacing);
    effect(() => {
      const newSpacing = parseInt(this.optionsService.options.value.pressure.spacing, 10);
      if (newSpacing !== lastSpacing) {
        lastSpacing = newSpacing;
        this.isobarLevels = generateIsobarLevels(newSpacing);
        this.renderer?.setPressureLevelCount(this.isobarLevels.length);
        this.lastPressureLerp = -1;  // Force contour recompute on next frame
        console.log(`[Render] Isobar spacing: ${newSpacing} hPa, ${this.isobarLevels.length} levels`);
      }
    });

    // Listen for pressure smoothing changes (live update)
    let lastSmoothing = this.optionsService.options.value.pressure.smoothing;
    effect(() => {
      const newSmoothing = this.optionsService.options.value.pressure.smoothing;
      if (newSmoothing !== lastSmoothing) {
        lastSmoothing = newSmoothing;
        this.lastPressureLerp = -1;  // Force contour recompute on next frame
        console.log(`[Render] Pressure smoothing: ${newSmoothing} iterations`);
      }
    });
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

      const tFrame = performance.now();

      this.animationId = requestAnimationFrame(render);

      const options = this.optionsService.options.value;
      const time = options.viewState.time;
      const rawLerp = this.tempLerpFn ? this.tempLerpFn(time) : -1;

      // Update animated opacities
      const now = performance.now() / 1000;
      const dt = this.lastFrameTime ? now - this.lastFrameTime : 0;
      this.lastFrameTime = now;
      this.updateAnimatedOpacities(options, rawLerp, dt);

      // Recompute pressure contours when lerp changes (threshold 0.005 ≈ 1 min at 3h timesteps)
      if (options.pressure.enabled && this.pressureLerpFn) {
        const pressureLerp = this.pressureLerpFn(time);
        const validLerp = pressureLerp >= 0 ? pressureLerp : (pressureLerp === -2 ? 0 : -1);
        if (validLerp >= 0 && Math.abs(validLerp - this.lastPressureLerp) > 0.005) {
          this.lastPressureLerp = validLerp;
          const smoothingIterations = parseInt(options.pressure.smoothing, 10);
          renderer.runPressureContour(this.pressureSlot0, this.pressureSlot1, validLerp, this.isobarLevels, smoothingIterations);
        }
      }

      renderer.updateUniforms({
        ...this.getCameraUniforms(renderer),
        ...this.getSunUniforms(time),
        ...this.getGridUniforms(),
        ...this.getLayerUniforms(),
        ...this.getTempUniforms(rawLerp),
        ...this.getRainUniforms(),
        ...this.getCloudsUniforms(),
        ...this.getHumidityUniforms(),
        ...this.getWindUniforms(),
        ...this.getPressureUniforms(),
      });

      const gpuTimeMs = renderer.render();
      this.frameTimes.push(performance.now() - tFrame);

      // Update perf panel DOM directly (no mithril redraw)
      if (this.perfFrameElement) {
        this.perfFrameElement.textContent = `frame: ${this.frameTimes.avg().toFixed(1)} ms`;
      }
      if (this.perfPassElement && gpuTimeMs !== null) {
        this.passTimes.push(gpuTimeMs);
        this.perfPassElement.textContent = `pass: ${this.passTimes.avg().toFixed(1)} ms`;
      }
      if (this.perfScreenElement) {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        this.perfScreenElement.textContent = `screen: ${w}×${h}`;
      }
      if (this.perfGlobeElement) {
        const distance = renderer.camera.getState().distance;
        const tanFov = renderer.camera.getTanFov();
        const fov = 2 * Math.atan(tanFov);
        const heightCss = this.canvas.clientHeight;
        const globeRadiusPx = Math.asin(1 / distance) * (heightCss / fov);
        this.perfGlobeElement.textContent = `globe: ${Math.round(globeRadiusPx)} px`;
      }
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
      gridLabelMaxRadius: this.configService.getConfig().grid.labelMaxRadiusPx,
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

  private getCloudsUniforms() {
    return {
      cloudsOpacity: this.animatedOpacity.clouds,
      cloudsDataReady: false,
    };
  }

  private getHumidityUniforms() {
    return {
      humidityOpacity: this.animatedOpacity.humidity,
      humidityDataReady: false,
    };
  }

  private getWindUniforms() {
    return {
      windOpacity: this.animatedOpacity.wind,
      windDataReady: false,
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

    // Compute targets: enabled && dataReady ? userOpacity : 0
    const tempDataReady = rawLerp >= -2 && rawLerp !== -1 && this.tempLoadedPoints > 0;
    const isReady = (layer: TWeatherLayer) =>
      layer === 'temp' ? tempDataReady : (this.dataReadyFns.get(layer)?.() ?? false);

    const targets = {} as Record<TLayer, number>;
    for (const layer of DECORATION_LAYERS) {
      targets[layer] = options[layer].enabled ? options[layer].opacity : 0;
    }
    for (const layer of WEATHER_LAYERS) {
      targets[layer] = (options[layer].enabled && isReady(layer)) ? options[layer].opacity : 0;
    }

    // Lerp each toward target (cast: Object.keys returns string[], we know the actual keys)
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
   * Get average frame time in ms (60-frame rolling average)
   */
  getFrameTimeAvg(): number {
    return this.frameTimes.avg();
  }

  /**
   * Set DOM elements for perf panel (updated directly in render loop)
   */
  setPerfElements(
    frameEl: HTMLElement | null,
    passEl: HTMLElement | null,
    screenEl: HTMLElement | null,
    globeEl: HTMLElement | null
  ): void {
    this.perfFrameElement = frameEl;
    this.perfPassElement = passEl;
    this.perfScreenElement = screenEl;
    this.perfGlobeElement = globeEl;
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
   * Set the function to calculate temp lerp (from SlotService)
   */
  setTempLerpFn(fn: (time: Date) => number): void {
    this.tempLerpFn = fn;
  }

  /**
   * Set the function to calculate pressure lerp (from SlotService)
   */
  setPressureLerpFn(fn: (time: Date) => number): void {
    this.pressureLerpFn = fn;
  }

  /**
   * Set data-ready function for a param (from SlotService)
   * Returns true when param has loaded data for current time
   */
  setDataReadyFn(param: TWeatherLayer, fn: () => boolean): void {
    this.dataReadyFns.set(param, fn);
  }

  /** Set callback for pressure resolution change (from SlotService) */
  setPressureResolutionChangeFn(fn: (slotsNeedingRegrid: number[]) => void): void {
    this.onPressureResolutionChange = fn;
  }

  /**
   * Update temperature palette texture
   */
  updateTempPalette(textureData: Uint8Array, min: number, max: number): void {
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

  // ============================================================
  // Generic slot methods (called by SlotService)
  // ============================================================

  /**
   * Upload data to a slot for a given param
   * @deprecated Use LayerStore.writeToSlab() + triggerPressureRegrid() for per-slot mode
   */
  uploadToSlot(param: TWeatherLayer, _data: Float32Array, _slotIndex: number): void {
    // Per-slot mode: data upload happens via LayerStore.writeToSlab()
    // Then trigger regrid via triggerPressureRegrid(slotIndex, buffer)
    console.warn(`[RenderService] uploadToSlot deprecated - use LayerStore.writeToSlab() for ${param}`);
  }

  /**
   * Activate slots for a given param (shader will use these slots)
   * Routes to param-specific activation
   */
  activateSlots(param: TWeatherLayer, slot0: number, slot1: number, loadedPoints: number): void {
    switch (param) {
      case 'temp':
        this.tempSlot0 = slot0;
        this.tempSlot1 = slot1;
        this.tempLoadedPoints = loadedPoints;
        break;
      case 'pressure':
        // Store slots for render loop interpolation
        this.pressureSlot0 = slot0;
        this.pressureSlot1 = slot1;
        this.lastPressureLerp = -1;  // Force recompute on next frame
        break;
      case 'rain':
      case 'wind':
        // TODO: implement when these layers support slots
        break;
    }
  }

  /**
   * Get max timeslots per layer from options
   */
  getMaxSlotsPerLayer(): number {
    return parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);
  }

  /**
   * Get GPU device for external buffer creation
   */
  getDevice(): GPUDevice {
    return this.renderer!.getDevice();
  }

  /**
   * Set texture layer slot buffers from LayerStore (rebind)
   * Called when active slots change for texture-sampled layers
   */
  setTextureLayerBuffers(param: TWeatherTextureLayer, buffer0: GPUBuffer, buffer1: GPUBuffer): void {
    this.renderer!.setTextureLayerBuffers(param, buffer0, buffer1);
  }

  /**
   * Trigger pressure regrid for a slot (per-slot mode)
   * @param slotIndex Grid slot index for output
   * @param inputBuffer Per-slot buffer containing O1280 raw data
   */
  triggerPressureRegrid(slotIndex: number, inputBuffer: GPUBuffer): void {
    this.renderer!.triggerPressureRegrid(slotIndex, inputBuffer);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
