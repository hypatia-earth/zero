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
import { KeyboardService } from './services/keyboard-service';
import { DataService, ProgressUpdate } from './services/data-service';
import { RenderService } from './services/render-service';
import { setupCameraControls } from './services/camera-controls';
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
  private dataService: DataService;
  private renderService: RenderService | null = null;
  private keyboardService: KeyboardService | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.configService = new ConfigService();
    this.optionsService = new OptionsService();
    this.stateService = new StateService(this.configService.getDefaultLayers());
    this.trackerService = new TrackerService();
    this.dateTimeService = new DateTimeService(this.configService.getDataWindowDays());
    this.dataService = new DataService(this.trackerService);
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
      this.renderService = new RenderService(
        this.canvas,
        this.optionsService,
        this.stateService,
        this.dataService
      );
      await this.renderService.initialize();

      // Step 4: Basemap
      BootstrapService.setStep('BASEMAP');
      await this.loadBasemap();

      // Step 5: Activate
      BootstrapService.setStep('ACTIVATE');
      this.renderService.start();
      this.setupResizeHandler();
      this.stateService.enableSync();
      this.keyboardService = new KeyboardService(this.stateService);
      setupCameraControls(this.canvas, this.renderService.getRenderer().camera, this.stateService);

      // Mount UI immediately (before data loading)
      this.mountUI();
      BootstrapService.complete();
      console.log('[App] Bootstrap complete');

      // Step 6: Load Data (background, don't block UI)
      this.loadTempData();

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

    await this.renderService!.getRenderer().loadBasemap(faces);
  }

  private async loadTempData(): Promise<void> {
    try {
      // Initialize data service (find latest available run from S3)
      await this.dataService.initialize();

      const currentTime = this.stateService.getTime();

      // Progressive loading with chunk callbacks
      await this.dataService.loadProgressiveInterleaved(
        currentTime,
        async (update: ProgressUpdate) => {
          // Upload full arrays to GPU (streaming updates as slices arrive)
          await this.renderService!.getRenderer().uploadTempData(update.data0, update.data1);
          this.renderService!.setTempLoadedPoints(update.data0.length);

          // Update bootstrap progress (55-95% range)
          const progress = 55 + (update.sliceIndex / update.totalSlices) * 40;
          BootstrapService.setProgress(progress);

          console.log(`[App] Uploaded slice ${update.sliceIndex}/${update.totalSlices} to GPU${update.done ? ' - DONE' : ''}`);
        }
      );

      console.log('[App] Temp data fully loaded');
    } catch (err) {
      console.warn('[App] Failed to load temp data:', err);
    }
  }

  private setupResizeHandler(): void {
    const handleResize = () => {
      this.renderService?.getRenderer().resize();
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

  getRenderer() {
    return this.renderService?.getRenderer() ?? null;
  }

  getServices() {
    return {
      config: this.configService,
      options: this.optionsService,
      state: this.stateService,
      tracker: this.trackerService,
      dateTime: this.dateTimeService,
      keyboard: this.keyboardService,
      data: this.dataService,
    };
  }
}
