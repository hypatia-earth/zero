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
import { BootstrapService } from './services/bootstrap-service';
import { CapabilitiesService } from './services/capabilities-service';
import { KeyboardService } from './services/keyboard-service';
import { QueueService } from './services/queue-service';
import { OmService } from './services/om-service';
import { TimestepService } from './services/timestep-service';
import { SlotService } from './services/slot-service';
import { RenderService } from './services/render-service';
import { setupCameraControls } from './services/camera-controls';
import { initOmWasm } from './adapters/om-file-adapter';
import { BootstrapModal } from './components/bootstrap-modal';
import { OptionsDialog } from './components/options-dialog';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { QueuePanel } from './components/queue-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';
import { OptionsPanel } from './components/options-panel';
import { FullscreenPanel } from './components/fullscreen-panel';

export const App: m.ClosureComponent = () => {
  // Services - initialized during bootstrap, then stable
  let configService: ConfigService;
  let optionsService: OptionsService;
  let stateService: StateService;
  let capabilitiesService: CapabilitiesService;
  let omService: OmService;
  let queueService: QueueService;
  let renderService: RenderService;
  let timestepService: TimestepService;
  let slotService: SlotService;
  let keyboardService: KeyboardService;

  return {
    async oninit() {
      const canvas = document.getElementById('globe') as HTMLCanvasElement;
      if (!canvas) {
        BootstrapService.setError('Canvas element #globe not found');
        return;
      }

      // Initialize foundation services
      configService = new ConfigService();
      await configService.init();
      optionsService = new OptionsService();
      stateService = new StateService(configService);
      omService = new OmService();

      m.redraw();

      try {
        // Step 1: Capabilities
        BootstrapService.setStep('CAPABILITIES');
        capabilitiesService = new CapabilitiesService(configService);
        await capabilitiesService.init();

        // Step 2: Config
        BootstrapService.setStep('CONFIG');
        await optionsService.load();

        // Step 3: Discovery (via TimestepService)
        BootstrapService.setStep('DISCOVERY');
        timestepService = new TimestepService(configService);
        await timestepService.initialize();

        // Step 4: Assets via QueueService
        BootstrapService.setStep('ASSETS');
        queueService = new QueueService();
        queueService.setOmService(omService);
        const f16 = !capabilitiesService.float32_filterable;
        const suffix = f16 ? '-16' : '';

        // 4a. LUTs
        const lutBuffers = await queueService.submitFileOrders(
          [
            { url: `/atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
            { url: `/atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
            { url: `/atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
          ],
          (i) => BootstrapService.updateProgress(`Loading LUTs ${i + 1}/3...`, 15 + (i / 11) * 5)
        );

        // 4b. Basemap faces
        const basemapBuffers = await queueService.submitFileOrders(
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
        const [wasmBuffer] = await queueService.submitFileOrders(
          [{ url: '/om-decoder.wasm', size: 2107564 }],
          () => BootstrapService.updateProgress('Loading WASM...', 15 + (9 / 11) * 5)
        );
        await initOmWasm(wasmBuffer!);

        // 4d. Font atlas
        const [fontBuffer] = await queueService.submitFileOrders(
          [{ url: '/fonts/plex-mono.png', size: 15926 }],
          () => BootstrapService.updateProgress('Loading font...', 15 + (10 / 12) * 5)
        );
        const fontAtlas = await createImageBitmap(new Blob([fontBuffer!], { type: 'image/png' }));

        // 4e. Gaussian grid LUTs (O1280)
        const [gaussianLatsBuffer, ringOffsetsBuffer] = await queueService.submitFileOrders(
          [
            { url: '/om1280/gaussian-lats.bin', size: 10240 },
            { url: '/om1280/ring-offsets.bin', size: 10240 },
          ],
          () => BootstrapService.updateProgress('Loading grid LUTs...', 15 + (11 / 12) * 5)
        );
        const gaussianLats = new Float32Array(gaussianLatsBuffer!);
        const ringOffsets = new Uint32Array(ringOffsetsBuffer!);

        // Step 5: GPU Init
        BootstrapService.setStep('GPU_INIT');
        renderService = new RenderService(canvas, optionsService, stateService, configService);
        await renderService.initialize(gaussianLats, ringOffsets);

        // Step 5: DATA - Initialize with assets from Step 4
        BootstrapService.setStep('DATA');
        const renderer = renderService.getRenderer();

        // 5a. Atmosphere LUTs
        renderer.createAtmosphereTextures({
          transmittance: lutBuffers[0]!,
          scattering: lutBuffers[1]!,
          irradiance: lutBuffers[2]!,
        });

        // 5c. Basemap
        await renderer.loadBasemap(basemapFaces);

        // 5d. Font atlas
        await renderer.loadFontAtlas(fontAtlas);

        // Finalize renderer
        renderer.finalize();

        // SlotService - manages timestep data loading
        slotService = new SlotService(
          stateService,
          timestepService,
          renderService,
          queueService,
          optionsService
        );

        // 5f. Temperature timesteps
        await BootstrapService.updateProgress('Loading temperature...', 50);
        await slotService.initialize();

        // 5g. Precipitation (placeholder)
        await BootstrapService.updateProgress('Loading precipitation 1/2...', 85);
        await BootstrapService.updateProgress('Loading precipitation 2/2...', 95);

        // Step 6: Activate
        BootstrapService.setStep('ACTIVATE');
        renderService.start();
        stateService.enableSync();
        keyboardService = new KeyboardService(stateService);
        setupCameraControls(canvas, renderer.camera, stateService, configService);

        BootstrapService.complete();
        console.log('%c[ZERO] Bootstrap complete', 'color: darkgreen; font-weight: bold');
        m.redraw();

        // Expose services for debugging (localhost only)
        if (location.hostname === 'localhost') {
          (window as unknown as { __hypatia: object }).__hypatia = {
            configService,
            optionsService,
            stateService,
            capabilitiesService,
            omService,
            timestepService,
            queueService,
            renderService,
            slotService,
            keyboardService,
          };
        }

      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
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

      if (!bootstrapState.complete || bootstrapState.error) {
        return m(BootstrapModal);
      }

      return [
        m(BootstrapModal),
        m(OptionsDialog, { optionsService }),
        m('.ui-container', [
          m(LogoPanel),
          m(LayersPanel, { configService, stateService, optionsService }),
          m(TimeCirclePanel, { stateService }),
          m(QueuePanel, { queueService }),
          m(TimeBarPanel, { stateService, slotService, timestepService }),
          m(FullscreenPanel),
          m(OptionsPanel, { optionsService }),
        ]),
      ];
    },
  };
};
