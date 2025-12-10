/**
 * RenderService - Manages renderer and render loop
 */

import { GlobeRenderer } from '../render/globe-renderer';
import { generateGaussianLUTs } from '../render/gaussian-grid';
import type { OptionsService } from './options-service';
import type { StateService } from './state-service';
import type { DataService } from './data-service';
import type { ConfigService } from './config-service';
import { getSunDirection } from '../utils/sun-position';

export class RenderService {
  private renderer: GlobeRenderer | null = null;
  private animationId: number | null = null;
  private tempLoadedPoints = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private optionsService: OptionsService,
    private stateService: StateService,
    private dataService: DataService,
    private configService: ConfigService
  ) {}

  async initialize(): Promise<void> {
    const cameraConfig = this.configService.getCameraConfig();
    this.renderer = new GlobeRenderer(this.canvas, cameraConfig);
    await this.renderer.initialize();

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

    const renderer = this.renderer;

    const render = () => {
      this.animationId = requestAnimationFrame(render);

      const options = this.optionsService.options.value;
      const state = this.stateService.get();
      const layers = state.layers;

      // Layer enabled from URL state, opacity from options
      const earthEnabled = layers.includes('earth');
      const sunEnabled = layers.includes('sun');
      const gridEnabled = layers.includes('grid');
      const tempEnabled = layers.includes('temp');
      const rainEnabled = layers.includes('rain');

      // Calculate temp interpolation
      const tempLerp = this.dataService.getTempInterpolation(state.time);

      const sunConfig = this.configService.getConfig().sun;

      renderer.updateUniforms({
        viewProjInverse: renderer.camera.getViewProjInverse(),
        eyePosition: renderer.camera.getEyePosition(),
        resolution: new Float32Array([this.canvas.width, this.canvas.height]),
        time: performance.now() / 1000,
        tanFov: renderer.camera.getTanFov(),
        sunEnabled,
        sunDirection: getSunDirection(state.time),
        sunCoreRadius: sunConfig.coreRadius,
        sunGlowRadius: sunConfig.glowRadius,
        sunCoreColor: new Float32Array(sunConfig.coreColor),
        sunGlowColor: new Float32Array(sunConfig.glowColor),
        gridEnabled,
        gridOpacity: options.grid.opacity,
        earthOpacity: earthEnabled ? options.earth.opacity : 0,
        tempOpacity: tempEnabled ? options.temp.opacity : 0,
        rainOpacity: rainEnabled ? options.rain.opacity : 0,
        tempDataReady: this.tempLoadedPoints > 0,
        rainDataReady: false,
        tempLerp,
        tempLoadedPoints: this.tempLoadedPoints,
      });

      renderer.render();
    };

    render();
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

  dispose(): void {
    this.stop();
    this.renderer?.dispose();
    this.renderer = null;
  }
}
