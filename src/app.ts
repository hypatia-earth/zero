/**
 * App - Main application orchestration
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { ConfigService } from './services/config-service';
import { OptionsService } from './services/options-service';
import { StateService } from './services/state-service';
import { TrackerService } from './services/tracker-service';
import { DateTimeService } from './services/datetime-service';
import { BootstrapService } from './services/bootstrap-service';
import { GlobeRenderer } from './render/globe-renderer';
import { generateGaussianLUTs } from './render/gaussian-grid';
import { getSunDirection } from './utils/sun-position';
import { BootstrapModal } from './components/bootstrap-modal';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';

export class App {
  private configService: ConfigService;
  private optionsService: OptionsService;
  private stateService: StateService;
  private trackerService: TrackerService;
  private dateTimeService: DateTimeService;
  private renderer: GlobeRenderer | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.configService = new ConfigService();
    this.optionsService = new OptionsService();
    this.stateService = new StateService(this.configService.getDefaultLayers());
    this.trackerService = new TrackerService();
    this.dateTimeService = new DateTimeService(this.configService.getDataWindowDays());
  }

  async bootstrap(): Promise<void> {
    try {
      // Step 1: Capabilities
      BootstrapService.setStep('CAPABILITIES');
      if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
      }

      // Step 2: Config
      BootstrapService.setStep('CONFIG');
      await this.optionsService.load();

      // Step 3: GPU Init
      BootstrapService.setStep('GPU_INIT');
      this.renderer = new GlobeRenderer(this.canvas);
      await this.renderer.initialize();

      // Upload Gaussian LUTs
      const luts = generateGaussianLUTs();
      this.renderer.uploadGaussianLUTs(luts.lats, luts.offsets);

      // Step 4: Basemap
      BootstrapService.setStep('BASEMAP');
      await this.loadBasemap();

      // Step 5: Activate
      BootstrapService.setStep('ACTIVATE');
      this.startRenderLoop();
      this.setupResizeHandler();
      this.stateService.enableSync();

      // Step 6: Load Data (placeholder - no actual data loading yet)
      BootstrapService.setStep('LOAD_DATA');
      BootstrapService.setProgress(80);

      // Step 7: Finalize
      BootstrapService.complete();
      console.log('[App] Bootstrap complete');

      // Mount UI
      this.mountUI();

      // React to options changes
      effect(() => {
        m.redraw();
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      BootstrapService.setError(message);
      console.error('[App] Bootstrap failed:', err);
    }
  }

  private async loadBasemap(): Promise<void> {
    const faceNames = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const faces: ImageBitmap[] = [];

    for (const name of faceNames) {
      const url = `/images/basemaps/rtopo2/${name}.png`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[App] Basemap face ${name} not found, using placeholder`);
          // Create gray placeholder
          const canvas = new OffscreenCanvas(256, 256);
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#333';
          ctx.fillRect(0, 0, 256, 256);
          faces.push(await createImageBitmap(canvas));
          continue;
        }
        const blob = await response.blob();
        faces.push(await createImageBitmap(blob));
      } catch {
        // Create placeholder on error
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 256, 256);
        faces.push(await createImageBitmap(canvas));
      }
    }

    await this.renderer!.loadBasemap(faces);
  }

  private startRenderLoop(): void {
    const render = () => {
      requestAnimationFrame(render);

      const options = this.optionsService.options.value;
      const state = this.stateService.get();

      this.renderer!.updateUniforms({
        viewProjInverse: this.renderer!.camera.getViewProjInverse(),
        eyePosition: this.renderer!.camera.getEyePosition(),
        resolution: new Float32Array([this.canvas.width, this.canvas.height]),
        time: performance.now() / 1000,
        sunEnabled: options.sun.enabled,
        sunDirection: getSunDirection(state.time),
        gridEnabled: options.grid.enabled,
        gridOpacity: options.grid.opacity,
        earthOpacity: options.earth.opacity,
        tempOpacity: options.temp.opacity,
        rainOpacity: options.rain.opacity,
        tempDataReady: false,
        rainDataReady: false,
      });

      this.renderer!.render();
    };

    render();
  }

  private setupResizeHandler(): void {
    const handleResize = () => {
      this.renderer?.resize();
    };
    window.addEventListener('resize', handleResize);
  }

  private mountUI(): void {
    const uiContainer = document.createElement('div');
    uiContainer.id = 'ui';
    uiContainer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    document.getElementById('app')!.appendChild(uiContainer);

    const AppUI: m.Component = {
      view: () => {
        return [
          m(BootstrapModal),
          m(LogoPanel),
          m(LayersPanel, {
            configService: this.configService,
            stateService: this.stateService,
            optionsService: this.optionsService,
          }),
          m(TimeCirclePanel, { stateService: this.stateService }),
          m(TimeBarPanel, {
            stateService: this.stateService,
            dateTimeService: this.dateTimeService,
          }),
        ];
      },
    };

    m.mount(uiContainer, AppUI);
  }

  getRenderer(): GlobeRenderer | null {
    return this.renderer;
  }

  getServices() {
    return {
      config: this.configService,
      options: this.optionsService,
      state: this.stateService,
      tracker: this.trackerService,
      dateTime: this.dateTimeService,
    };
  }
}
