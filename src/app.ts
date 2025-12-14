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
// DiscoveryService replaced by TimestepService
import { QueueService } from './services/queue-service';
import { DataService } from './services/data-service';
// New services (alongside old for migration)
import { OmService } from './services/om-service';
import { TimestepService } from './services/timestep-service';
import { SlotService } from './services/slot-service';
// DataLoader removed - all static assets now via QueueService
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
  queueService?: QueueService;
  dataService?: DataService;
  renderService?: RenderService;
  budgetService?: BudgetService;
  keyboardService?: KeyboardService;
  canvas?: HTMLCanvasElement;
  // New services
  timestepService?: TimestepService;
  omService?: OmService;
  slotService?: SlotService;

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

    m.redraw();

    try {
      // Step 1: Capabilities
      BootstrapService.setStep('CAPABILITIES');
      this.capabilitiesService = new CapabilitiesService();
      await this.capabilitiesService.init();

      // Step 2: Config
      BootstrapService.setStep('CONFIG');
      await this.optionsService.load();

      // Step 3: Discovery (via TimestepService)
      BootstrapService.setStep('DISCOVERY');
      this.timestepService = new TimestepService(this.configService);
      await this.timestepService.initialize();

      // Step 4: Assets via QueueService
      // Total 11 items: 3 LUTs + 6 basemap + 1 WASM + 1 font, progress 15-20%
      BootstrapService.setStep('ASSETS');
      this.queueService = new QueueService(this.fetchService);

      // Wire up OmService to QueueService
      this.omService = new OmService(this.fetchService);
      this.queueService.setOmService(this.omService);
      const f16 = !this.capabilitiesService.float32_filterable;
      const suffix = f16 ? '-16' : '';

      // 4a. LUTs
      const lutBuffers = await this.queueService.submitFileOrders(
        [
          { url: `/atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
          { url: `/atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
          { url: `/atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
        ],
        (i) => BootstrapService.updateProgress(`Loading LUTs ${i + 1}/3...`, 15 + (i / 11) * 5)
      );

      // 4b. Basemap faces
      const basemapBuffers = await this.queueService.submitFileOrders(
        [
          { url: '/images/basemaps/rtopo2/px.png', size: 111244 },
          { url: '/images/basemaps/rtopo2/nx.png', size: 78946 },
          { url: '/images/basemaps/rtopo2/py.png', size: 215476 },
          { url: '/images/basemaps/rtopo2/ny.png', size: 292274 },
          { url: '/images/basemaps/rtopo2/pz.png', size: 85084 },
          { url: '/images/basemaps/rtopo2/nz.png', size: 59133 },
        ],
        (i) => BootstrapService.updateProgress(`Loading basemap ${i + 1}/6...`, 15 + ((3 + i) / 11) * 5)
      );
      const basemapFaces = await Promise.all(
        basemapBuffers.map(buf => createImageBitmap(new Blob([buf], { type: 'image/png' })))
      );

      // 4c. WASM decoder
      const [wasmBuffer] = await this.queueService.submitFileOrders(
        [{ url: '/om-decoder.wasm', size: 2107564 }],
        () => BootstrapService.updateProgress('Loading WASM...', 15 + (9 / 11) * 5)
      );
      await initOmWasm(wasmBuffer!);

      // 4d. Font atlas
      const [fontBuffer] = await this.queueService.submitFileOrders(
        [{ url: '/fonts/plex-mono.png', size: 15926 }],
        () => BootstrapService.updateProgress('Loading font...', 15 + (10 / 11) * 5)
      );
      const fontAtlas = await createImageBitmap(new Blob([fontBuffer!], { type: 'image/png' }));

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

      // Step 5: DATA - Initialize with assets from Step 4
      BootstrapService.setStep('DATA');
      const renderer = this.renderService.getRenderer();

      // 5a. Atmosphere LUTs (from Step 4a)
      renderer.createAtmosphereTextures({
        transmittance: lutBuffers[0]!,
        scattering: lutBuffers[1]!,
        irradiance: lutBuffers[2]!,
      });

      // 5c. Basemap (from Step 4b)
      await renderer.loadBasemap(basemapFaces);

      // 5d. Font atlas (from Step 4d)
      // const fontAtlas = await this.dataLoader.loadFontAtlas();
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

      // SlotService (for migration - not yet used)
      this.slotService = new SlotService(
        this.configService,
        this.stateService,
        this.timestepService!,
        this.renderService,
        this.queueService
      );

      // 5f. Temperature timesteps
      await BootstrapService.updateProgress('Loading temperature 1/2...', 50);
      await this.budgetService.loadSingleInitialTimestep(0, 2);
      await BootstrapService.updateProgress('Loading temperature 2/2...', 70);
      await this.budgetService.loadSingleInitialTimestep(1, 2);

      // 5g. Precipitation (placeholder)
      await BootstrapService.updateProgress('Loading precipitation 1/2...', 85);
      await BootstrapService.updateProgress('Loading precipitation 2/2...', 95);

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
          timestepService: this.timestepService,
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
