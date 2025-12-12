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
import { FetchService } from './services/fetch-service';
import { DateTimeService } from './services/datetime-service';
import { BootstrapService } from './services/bootstrap-service';
import { KeyboardService } from './services/keyboard-service';
import { DataService } from './services/data-service';
import { DataLoader } from './services/data-loader';
import { RenderService } from './services/render-service';
import { BudgetService } from './services/budget-service';
import { setupCameraControls } from './services/camera-controls';
import { initOmWasm } from './adapters/om-file-adapter';
import { BootstrapModal } from './components/bootstrap-modal';
import { OptionsDialog } from './components/options-dialog';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';
import { GearIcon } from './components/GearIcon';

interface AppComponent extends m.Component {
  configService?: ConfigService;
  optionsService?: OptionsService;
  stateService?: StateService;
  trackerService?: TrackerService;
  fetchService?: FetchService;
  dateTimeService?: DateTimeService;
  dataService?: DataService;
  dataLoader?: DataLoader;
  renderService?: RenderService;
  budgetService?: BudgetService;
  keyboardService?: KeyboardService;
  canvas?: HTMLCanvasElement;

  oninit(): Promise<void>;
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
    await this.configService.init();  // Load runtime config overrides
    this.optionsService = new OptionsService();
    this.stateService = new StateService(this.configService.getDefaultLayers());
    this.trackerService = new TrackerService();
    this.fetchService = new FetchService(this.trackerService);
    this.dateTimeService = new DateTimeService(this.configService.getDataWindowDays());
    this.dataService = new DataService(this.fetchService);
    this.dataLoader = new DataLoader(this.fetchService);

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

      // Step 3: GPU Init (no data loading)
      BootstrapService.setStep('GPU_INIT');
      this.renderService = new RenderService(
        this.canvas,
        this.optionsService,
        this.stateService,
        this.dataService,
        this.configService
      );
      await this.renderService.initialize();

      // Step 4: DATA - Load all assets sequentially
      BootstrapService.setStep('DATA');
      const renderer = this.renderService.getRenderer();

      // 4a. WASM decoder
      const wasmBinary = await this.dataLoader.loadWasm();
      await initOmWasm(wasmBinary);

      // 4b. Atmosphere LUTs
      const useFloat16 = renderer.getUseFloat16Luts();
      const lutData = await this.dataLoader.loadAtmosphereLUTs(useFloat16);
      renderer.createAtmosphereTextures(lutData, useFloat16);

      // 4c. Basemap
      const faces = await this.dataLoader.loadBasemap();
      await renderer.loadBasemap(faces);

      // Finalize renderer (create bind group now that textures are loaded)
      renderer.finalize();

      // 4d. Initialize DataService (find latest run from S3)
      await BootstrapService.updateProgress('Finding latest data...', 70);
      await this.dataService.initialize();

      // Create BudgetService (manages slots)
      this.budgetService = new BudgetService(
        this.configService,
        this.stateService,
        this.dataService,
        this.renderService
      );

      // 4e. Temperature timesteps - use DataLoader for progress tracking
      await this.dataLoader.loadTemperatureTimesteps(
        this.budgetService.loadSingleInitialTimestep.bind(this.budgetService)
      );

      // 4f. Precipitation (placeholder)
      await this.dataLoader.loadPrecipitationTimesteps();

      // Step 5: Activate
      BootstrapService.setStep('ACTIVATE');
      this.renderService.start();
      this.stateService.enableSync();
      this.keyboardService = new KeyboardService(this.stateService);
      setupCameraControls(this.canvas, renderer.camera, this.stateService, this.configService);

      BootstrapService.complete();
      console.log('%c[ZERO] Bootstrap complete', 'color: darkgreen; font-weight: bold');
      m.redraw();

      // Expose services for debugging (localhost only)
      if (location.hostname === 'localhost') {
        (window as unknown as { __hypatia: object }).__hypatia = {
          configService: this.configService,
          optionsService: this.optionsService,
          stateService: this.stateService,
          trackerService: this.trackerService,
          fetchService: this.fetchService,
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
      m(OptionsDialog, { optionsService: this.optionsService! }),
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
        // Options gear button
        m('div.options.panel', [
          m('button.control.circle', {
            onclick: () => this.optionsService!.openDialog(),
            title: 'Options'
          }, m(GearIcon))
        ]),
      ]),
    ];
  },
};
