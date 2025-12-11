/**
 * App - Main application orchestration
 *
 * Renders as Mithril component with two phases:
 * 1. Bootstrap: Shows modal with progress, UI hidden
 * 2. Ready: Modal fades out, UI fades in
 */

import m from 'mithril';
import { ConfigService } from './services/config-service';
import { OptionsService } from './services/options-service';
import { StateService } from './services/state-service';
import { TrackerService } from './services/tracker-service';
import { DateTimeService } from './services/datetime-service';
import { BootstrapService } from './services/bootstrap-service';
import { KeyboardService } from './services/keyboard-service';
import { DataService } from './services/data-service';
import { RenderService } from './services/render-service';
import { BudgetService } from './services/budget-service';
import { setupCameraControls } from './services/camera-controls';
import { BootstrapModal } from './components/bootstrap-modal';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';

interface AppComponent extends m.Component {
  configService?: ConfigService;
  optionsService?: OptionsService;
  stateService?: StateService;
  trackerService?: TrackerService;
  dateTimeService?: DateTimeService;
  dataService?: DataService;
  renderService?: RenderService;
  budgetService?: BudgetService;
  keyboardService?: KeyboardService;
  canvas?: HTMLCanvasElement;

  oninit(): Promise<void>;
  loadBasemap(): Promise<void>;
  view(): m.Children;
}

export const App: AppComponent = {
  async oninit() {
    // Get canvas element
    this.canvas = document.getElementById('globe') as HTMLCanvasElement;
    if (!this.canvas) {
      BootstrapService.setError('Canvas element #globe not found');
      return;
    }

    // Initialize foundation services
    this.configService = new ConfigService();
    this.optionsService = new OptionsService();
    this.stateService = new StateService(this.configService.getDefaultLayers());
    this.trackerService = new TrackerService();
    this.dateTimeService = new DateTimeService(this.configService.getDataWindowDays());
    this.dataService = new DataService(this.trackerService);

    m.redraw();

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
        this.dataService,
        this.configService
      );
      await this.renderService.initialize();

      // Step 4: Basemap
      BootstrapService.setStep('BASEMAP');
      await this.loadBasemap();

      // Step 5: Activate
      BootstrapService.setStep('ACTIVATE');
      this.renderService.start();
      this.stateService.enableSync();
      this.keyboardService = new KeyboardService(this.stateService);
      setupCameraControls(this.canvas, this.renderService.getRenderer().camera, this.stateService, this.configService);

      // Create BudgetService (manages GPU timestep buffer)
      this.budgetService = new BudgetService(
        this.configService,
        this.stateService,
        this.dataService,
        this.renderService
      );

      BootstrapService.complete();
      console.log('%c[ZERO] Bootstrap complete', 'color: darkgreen; font-weight: bold');
      m.redraw();

      // Step 6: Load Data (background, don't block UI)
      this.budgetService.loadInitialTimesteps();

      // Expose services for debugging (localhost only)
      if (location.hostname === 'localhost') {
        (window as unknown as { __hypatia: object }).__hypatia = {
          configService: this.configService,
          optionsService: this.optionsService,
          stateService: this.stateService,
          trackerService: this.trackerService,
          dateTimeService: this.dateTimeService,
          dataService: this.dataService,
          renderService: this.renderService,
          budgetService: this.budgetService,
        };
      }

    } catch (err) {
      const message = err instanceof Error
        ? `${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(1, 4).join('\n') : ''}`
        : String(err);
      BootstrapService.setError(message);
      console.error('[ZERO] Bootstrap failed:', err);
      m.redraw();
    }
  },

  async loadBasemap() {
    const faceNames = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const faces: ImageBitmap[] = [];

    for (const name of faceNames) {
      const url = `/images/basemaps/rtopo2/${name}.png`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[ZERO] Basemap face ${name} not found, using placeholder`);
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
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 256, 256);
        faces.push(await createImageBitmap(canvas));
      }
    }

    await this.renderService!.getRenderer().loadBasemap(faces);
  },

  view() {
    const bootstrapState = BootstrapService.state.value;

    // During bootstrap - show modal only
    if (!bootstrapState.complete) {
      return m(BootstrapModal);
    }

    // Error state - show modal with error
    if (bootstrapState.error) {
      return m(BootstrapModal);
    }

    // Bootstrap complete - show modal (fading out) + UI
    return [
      m(BootstrapModal),
      m('div.ui-container', {
        style: 'position: absolute; inset: 0; pointer-events: none;'
      }, [
        m(LogoPanel),
        m(LayersPanel, {
          configService: this.configService!,
          stateService: this.stateService!,
          optionsService: this.optionsService!,
        }),
        m(TimeCirclePanel, { stateService: this.stateService! }),
        this.budgetService && m(TimeBarPanel, {
          stateService: this.stateService!,
          dateTimeService: this.dateTimeService!,
          budgetService: this.budgetService,
        }),
      ]),
    ];
  },
};
