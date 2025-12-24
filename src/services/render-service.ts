/**
 * RenderService - Manages renderer and render loop
 */

import { effect } from '@preact/signals-core';
import { GlobeRenderer } from '../render/globe-renderer';
import { generateIsobarLevels } from '../render/pressure-layer';
import { validateGlobeUniforms } from '../render/globe-uniforms';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import type { StateService } from './state-service';
import type { ZeroOptions } from '../schemas/options.schema';
import { DECORATION_LAYERS, WEATHER_LAYERS, isWeatherLayer, type TLayer, type TWeatherLayer, type TWeatherTextureLayer, type LayerState } from '../config/types';
import { getSunDirection } from '../utils/sun-position';
import { createRingBuffer, type RingBuffer } from '../utils/ringbuffer';

export class RenderService {
  private renderer: GlobeRenderer | null = null;
  private animationId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tempLoadedPoints = 0;
  private tempPaletteRange: Float32Array = new Float32Array([-40, 50]); // Default range

  // Active slot indices per layer (populated by activateSlots)
  private activeSlots = new Map<TWeatherLayer, { slot0: number; slot1: number }>();

  // Pressure contour state
  private lastPressureMinute = -1;  // For minute-based change detection
  private isobarLevels: number[] = generateIsobarLevels(4);  // Default spacing

  // Wind layer state
  private windHasData = false;  // Set when wind buffers are loaded

  // Weather layer state functions (set by SlotService)
  private layerStateFns = new Map<TWeatherLayer, (time: Date) => LayerState>();

  // Animated opacity state (lerps toward target each frame)
  private lastFrameTime = 0;
  private animatedOpacity: Record<TLayer, number> = Object.fromEntries(
    [...DECORATION_LAYERS, ...WEATHER_LAYERS].map(layer => [layer, 0])
  ) as Record<TLayer, number>;

  // Callback when pressure resolution changes (slots needing regrid)
  private onPressureResolutionChange: ((slotsNeedingRegrid: number[]) => void) | null = null;

  // Frame timing (60-frame rolling average)
  private frameTimes: RingBuffer = createRingBuffer(60);
  private passTimes: RingBuffer = createRingBuffer(60);
  private frameIntervals: RingBuffer = createRingBuffer(60);
  private perfFpsElement: HTMLElement | null = null;
  private perfFrameElement: HTMLElement | null = null;
  private perfPassElement: HTMLElement | null = null;
  private perfScreenElement: HTMLElement | null = null;
  private perfGlobeElement: HTMLElement | null = null;

  // Gaussian grid lookup tables (for synthetic data generation)
  private gaussianLats: Float32Array | null = null;

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

  async initialize(gaussianLats: Float32Array, ringOffsets: Uint32Array): Promise<void> {
    // Validate uniform layout at startup
    validateGlobeUniforms();

    // Initialize active slots for ready weather layers
    const readyWeatherLayers = this.configService.getConfig().readyLayers.filter(isWeatherLayer);
    for (const layer of readyWeatherLayers) {
      this.activeSlots.set(layer, { slot0: 0, slot1: 0 });
    }

    const cameraConfig = this.configService.getCameraConfig();
    this.renderer = new GlobeRenderer(this.canvas, cameraConfig);

    // Get timeslots per layer from user options
    const timeslotsPerLayer = parseInt(this.optionsService.options.value.gpu.timeslotsPerLayer, 10);

    // Get pressure resolution from options (1 or 2 degrees)
    const resolutionMap = { '1': 1, '2': 2 } as const;
    const pressureResolution = resolutionMap[this.optionsService.options.value.pressure.resolution];

    // Get wind line count from options
    const windLineCount = this.optionsService.options.value.wind.seedCount;

    await this.renderer.initialize(timeslotsPerLayer, pressureResolution, windLineCount);

    // Upload pre-computed Gaussian LUTs (O1280 grid)
    this.renderer.uploadGaussianLUTs(gaussianLats, ringOffsets);
    this.gaussianLats = gaussianLats;

    // Listen for pressure resolution changes (live update)
    let lastResolution = pressureResolution;
    effect(() => {
      const newResolution = resolutionMap[this.optionsService.options.value.pressure.resolution];
      if (newResolution !== lastResolution) {
        lastResolution = newResolution;
        const slotsNeedingRegrid = this.renderer?.setPressureResolution(newResolution) ?? [];
        this.lastPressureMinute = -1;  // Force contour recompute on next frame
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
        this.lastPressureMinute = -1;  // Force contour recompute on next frame
        console.log(`[Render] Isobar spacing: ${newSpacing} hPa, ${this.isobarLevels.length} levels`);
      }
    });

    // Listen for pressure smoothing changes (live update)
    let lastSmoothing = this.optionsService.options.value.pressure.smoothing;
    effect(() => {
      const newSmoothing = this.optionsService.options.value.pressure.smoothing;
      if (newSmoothing !== lastSmoothing) {
        lastSmoothing = newSmoothing;
        this.lastPressureMinute = -1;  // Force contour recompute on next frame
        console.log(`[Render] Pressure smoothing: ${newSmoothing} iterations`);
      }
    });

    // Listen for wind line count changes (live update)
    let lastLineCount = this.optionsService.options.value.wind.seedCount;
    effect(() => {
      const newLineCount = this.optionsService.options.value.wind.seedCount;
      if (newLineCount !== lastLineCount) {
        lastLineCount = newLineCount;
        this.renderer?.getWindLayer().setLineCount(newLineCount);
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

    let lastRafTime = 0;
    let frameDebt = 0;
    const TARGET_FRAME_TIME = 1000 / 30;  // 30 fps = 33.33ms

    const render = (rafTime: DOMHighResTimeStamp) => {

      this.animationId = requestAnimationFrame(render);

      const options = this.optionsService.options.value;

      // Battery saver: accumulate time, render when enough has passed
      if (options.debug.batterySaver) {
        const delta = lastRafTime ? rafTime - lastRafTime : TARGET_FRAME_TIME;
        lastRafTime = rafTime;
        frameDebt += delta;
        if (frameDebt < TARGET_FRAME_TIME) {
          return;
        }
        frameDebt = Math.min(frameDebt - TARGET_FRAME_TIME, TARGET_FRAME_TIME);
      }

      const tFrame = performance.now();
      const time = this.stateService.viewState.value.time;
      const loadingState: LayerState = { mode: 'loading', lerp: 0, time };

      // Get layer states
      const getState = (layer: TWeatherLayer) => this.layerStateFns.get(layer)?.(time) ?? loadingState;
      const tempState = getState('temp');
      const pressureState = getState('pressure');
      const windState = getState('wind');
      const rainState = getState('rain');
      const cloudsState = getState('clouds');
      const humidityState = getState('humidity');

      // Update animated opacities and track frame intervals for FPS
      const now = performance.now() / 1000;
      const dt = this.lastFrameTime ? now - this.lastFrameTime : 0;
      if (dt > 0) this.frameIntervals.push(dt * 1000);
      this.lastFrameTime = now;
      this.updateAnimatedOpacities(options, {
        temp: tempState, pressure: pressureState, wind: windState,
        rain: rainState, clouds: cloudsState, humidity: humidityState
      }, dt);

      // Recompute pressure contours when time changes by at least 1 minute
      if (options.pressure.enabled && pressureState.mode !== 'loading') {
        const currentMinute = Math.floor(time.getTime() / 60000);
        if (currentMinute !== this.lastPressureMinute) {
          this.lastPressureMinute = currentMinute;
          const smoothingIterations = parseInt(options.pressure.smoothing, 10);
          const pSlots = this.activeSlots.get('pressure')!;
          renderer.runPressureContour(pSlots.slot0, pSlots.slot1, pressureState.lerp, this.isobarLevels, smoothingIterations);
        }
      }

      renderer.updateUniforms({
        ...this.getCameraUniforms(renderer),
        ...this.getSunUniforms(time),
        ...this.getGridUniforms(),
        ...this.getLayerUniforms(),
        ...this.getTempUniforms(tempState),
        ...this.getRainUniforms(),
        ...this.getCloudsUniforms(),
        ...this.getHumidityUniforms(),
        ...this.getWindUniforms(windState),
        ...this.getPressureUniforms(),
        ...this.getLogoUniforms(),
      });

      const gpuTimeMs = renderer.render();
      this.frameTimes.push(performance.now() - tFrame);

      // Update perf panel DOM directly (no mithril redraw)
      if (this.perfFpsElement && this.frameIntervals.avg() > 0) {
        const fps = 1000 / this.frameIntervals.avg();
        this.perfFpsElement.textContent = `${fps.toFixed(0)}`;
      }
      if (this.perfFrameElement) {
        this.perfFrameElement.textContent = `${this.frameTimes.avg().toFixed(1)} ms`;
      }
      if (this.perfPassElement && gpuTimeMs !== null) {
        this.passTimes.push(gpuTimeMs);
        this.perfPassElement.textContent = `${this.passTimes.avg().toFixed(1)} ms`;
      }
      if (this.perfScreenElement) {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        this.perfScreenElement.textContent = `${w}×${h}`;
      }
      if (this.perfGlobeElement) {
        const distance = renderer.camera.getState().distance;
        const tanFov = renderer.camera.getTanFov();
        const fov = 2 * Math.atan(tanFov);
        const heightCss = this.canvas.clientHeight;
        const globeRadiusPx = Math.asin(1 / distance) * (heightCss / fov);
        this.perfGlobeElement.textContent = `${Math.round(globeRadiusPx)} px`;
      }
    };

    requestAnimationFrame(render);
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

  private getTempUniforms(state: LayerState) {
    // tempDataReady = data exists in buffers (not whether we should render)
    // Opacity animation handles fade in/out based on state.mode
    const tempDataReady = this.tempLoadedPoints > 0;
    const slots = this.activeSlots.get('temp')!;
    return {
      tempOpacity: this.animatedOpacity.temp,
      tempDataReady,
      tempLerp: state.mode === 'single' ? -2 : state.lerp,  // -2 = single slot mode (no interpolation)
      tempLoadedPoints: this.tempLoadedPoints,
      tempSlot0: slots.slot0,
      tempSlot1: slots.slot1,
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

  private getWindUniforms(state: LayerState) {
    return {
      windOpacity: this.animatedOpacity.wind,
      // windDataReady = buffers exist (not whether time matches - opacity handles that)
      windDataReady: this.windHasData,
      windLerp: state.mode === 'single' ? 0 : state.lerp,
      windAnimSpeed: this.optionsService.options.value.wind.speed,
      windState: state,  // Pass full state for compute caching
    };
  }

  private getPressureUniforms() {
    return {
      pressureOpacity: this.animatedOpacity.pressure,
    };
  }

  private getLogoUniforms() {
    // Logo only visible when enabled and ALL layers are disabled
    if (!this.configService.getConfig().render.logoEnabled) {
      return { logoOpacity: 0 };
    }
    // Check if any layer is enabled (not just visible - loading layers count as enabled)
    const opts = this.optionsService.options.value;
    const anyEnabled = [...DECORATION_LAYERS, ...WEATHER_LAYERS].some(l => opts[l].enabled);
    return { logoOpacity: anyEnabled ? 0 : 1 };
  }

  /**
   * Update animated opacities toward targets (called each frame)
   * Uses exponential decay for smooth ~100ms transitions
   */
  private updateAnimatedOpacities(
    options: ZeroOptions,
    states: Record<TWeatherLayer, LayerState>,
    dt: number
  ): void {
    const animMs = this.configService.getConfig().render.opacityAnimationMs;
    const rate = 1000 / animMs;  // Convert ms to rate (e.g., 100ms → 10/s)
    const factor = Math.min(1, dt * rate);

    // Compute targets: enabled && dataReady ? userOpacity : 0
    // Use LayerState.mode to determine if data is ready for current time
    const isReady = (layer: TWeatherLayer): boolean => {
      // Temp needs extra check for progressive loading
      if (layer === 'temp') return states[layer].mode !== 'loading' && this.tempLoadedPoints > 0;
      return states[layer].mode !== 'loading';
    };

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
    fpsEl: HTMLElement | null,
    frameEl: HTMLElement | null,
    passEl: HTMLElement | null,
    screenEl: HTMLElement | null,
    globeEl: HTMLElement | null
  ): void {
    this.perfFpsElement = fpsEl;
    this.perfFrameElement = frameEl;
    this.perfPassElement = passEl;
    this.perfScreenElement = screenEl;
    this.perfGlobeElement = globeEl;
  }

  /**
   * Set active slot indices for temperature interpolation
   */
  setTempSlots(slot0: number, slot1: number): void {
    this.activeSlots.set('temp', { slot0, slot1 });
  }

  getTempSlots(): { slot0: number; slot1: number } {
    return this.activeSlots.get('temp')!;
  }

  /** Set the state function for a weather layer (from SlotService) */
  setLayerStateFn(layer: TWeatherLayer, fn: (time: Date) => LayerState): void {
    this.layerStateFns.set(layer, fn);
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
   */
  activateSlots(param: TWeatherLayer, slot0: number, slot1: number, loadedPoints: number): void {
    this.activeSlots.set(param, { slot0, slot1 });

    // Layer-specific side effects
    if (param === 'temp') {
      this.tempLoadedPoints = loadedPoints;
    } else if (param === 'pressure') {
      this.lastPressureMinute = -1;  // Force recompute on next frame
    }
  }

  /**
   * Get active slot indices for a param
   */
  getActiveSlots(param: TWeatherLayer): { slot0: number; slot1: number } {
    return this.activeSlots.get(param) ?? { slot0: 0, slot1: 0 };
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
   * Get Gaussian latitudes for O1280 grid (for synthetic data generation)
   */
  getGaussianLats(): Float32Array | null {
    return this.gaussianLats;
  }

  /**
   * Set texture layer slot buffers from LayerStore (rebind)
   * Called when active slots change for texture-sampled layers
   */
  setTextureLayerBuffers(param: TWeatherTextureLayer, buffer0: GPUBuffer, buffer1: GPUBuffer): void {
    this.renderer!.setTextureLayerBuffers(param, buffer0, buffer1);
  }

  /**
   * Set wind layer buffers (U0, V0, U1, V1 for two timesteps)
   */
  setWindLayerBuffers(u0: GPUBuffer, v0: GPUBuffer, u1: GPUBuffer, v1: GPUBuffer): void {
    this.renderer!.setWindLayerBuffers(u0, v0, u1, v1);
    this.windHasData = true;
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
