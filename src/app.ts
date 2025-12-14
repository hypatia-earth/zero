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
import { CapabilitiesService } from './services/capabilities-service';
import { KeyboardService } from './services/keyboard-service';
import { DiscoveryService } from './services/discovery-service';
import { QueueService } from './services/queue-service';
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
import { QueuePanel } from './components/queue-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';
import { GearIcon } from './components/GearIcon';
import { FullscreenPanel } from './components/fullscreen-panel';

interface AppComponent extends m.Component {
  configService?: ConfigService;
  optionsService?: OptionsService;
  stateService?: StateService;
  trackerService?: TrackerService;
  fetchService?: FetchService;
  dateTimeService?: DateTimeService;
  capabilitiesService?: CapabilitiesService;
  discoveryService?: DiscoveryService;
  queueService?: QueueService;
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
      this.capabilitiesService = new CapabilitiesService();
      await this.capabilitiesService.init();

      // Step 2: Config
      BootstrapService.setStep('CONFIG');
      await this.optionsService.load();

      // Step 3: Discovery
      BootstrapService.setStep('DISCOVERY');
      this.discoveryService = new DiscoveryService(this.configService);
      await this.discoveryService.explore();

      // Step 4: Assets (load LUTs via QueueService)
      BootstrapService.setStep('ASSETS');
      this.queueService = new QueueService(this.fetchService);
      const f16 = !this.capabilitiesService.float32_filterable;
      const suffix = f16 ? '-16' : '';
      const lutBuffers = await this.queueService.submitFileOrders(
        [
          { url: `/atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
          { url: `/atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
          { url: `/atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
        ],
        (i, total) => BootstrapService.updateProgress(`Loading LUTs ${i + 1}/${total}...`, 15 + (i / total) * 5)
      );
      console.log(`[Queue] loaded ${lutBuffers.length} LUTs`);

      // Step 5: GPU Init (no data loading)
      BootstrapService.setStep('GPU_INIT');
      this.renderService = new RenderService(
        this.canvas,
        this.optionsService,
        this.stateService,
        this.dataService,
        this.configService
      );
      await this.renderService.initialize();

      // Step 5: DATA - Load all assets sequentially
      BootstrapService.setStep('DATA');
      const renderer = this.renderService.getRenderer();

      // 5a. WASM decoder
      const wasmBinary = await this.dataLoader.loadWasm();
      await initOmWasm(wasmBinary);

      // 5b. Atmosphere LUTs
      const useFloat16 = renderer.getUseFloat16Luts();
      const lutData = await this.dataLoader.loadAtmosphereLUTs(useFloat16);
      renderer.createAtmosphereTextures(lutData, useFloat16);

      // 5c. Basemap
      const faces = await this.dataLoader.loadBasemap();
      await renderer.loadBasemap(faces);

      // 5d. Font atlas for grid labels
      const fontAtlas = await this.dataLoader.loadFontAtlas();
      await renderer.loadFontAtlas(fontAtlas);

      // Finalize renderer (create bind group now that textures are loaded)
      renderer.finalize();

      // 5e. Initialize DataService (find latest run from S3)
      await BootstrapService.updateProgress('Finding latest data...', 70);
      await this.dataService.initialize();

      // Create BudgetService (manages slots)
      this.budgetService = new BudgetService(
        this.configService,
        this.stateService,
        this.dataService,
        this.renderService
      );

      // 5f. Temperature timesteps - use DataLoader for progress tracking
      await this.dataLoader.loadTemperatureTimesteps(
        this.budgetService.loadSingleInitialTimestep.bind(this.budgetService)
      );

      // 5g. Precipitation (placeholder)
      await this.dataLoader.loadPrecipitationTimesteps();

      // Step 6: Activate
      BootstrapService.setStep('ACTIVATE');
      this.renderService.start();
      this.stateService.enableSync();
      this.keyboardService = new KeyboardService(this.stateService);
      // TODO: can this happen in renderService.start()
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
          capabilitiesService: this.capabilitiesService,
          discoveryService: this.discoveryService,
          queueService: this.queueService,
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
        m(QueuePanel, { queueService: this.queueService! }),
        m(TimeBarPanel, {
          stateService: this.stateService!,
          dateTimeService: this.dateTimeService!,
          budgetService: this.budgetService!,
        }),
        m(FullscreenPanel),
        // TODO: should become OptionsPanel
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
