/**
 * App - Main application orchestration
 *
 * Renders as Mithril component with two phases:
 * 1. Bootstrap: Shows modal with progress, UI hidden
 * 2. Ready: Modal fades out, UI fades in
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { ConfigService } from './services/config-service';
import { OptionsService } from './services/options-service';
import { BootstrapService } from './services/bootstrap-service';
import { CapabilitiesService } from './services/capabilities-service';
import { KeyboardService } from './services/keyboard-service';
import { QueueService } from './services/queue-service';
import { OmService } from './services/om-service';
import { TimestepService } from './services/timestep-service';
import { SlotService } from './services/slot-service';
import { RenderService } from './services/render-service';
import { PaletteService } from './services/palette-service';
import { ThemeService } from './services/theme-service';
import { setupCameraControls } from './services/camera-controls';
import { initOmWasm } from './adapters/om-file-adapter';
import { BootstrapModal } from './components/bootstrap-modal';
import { OptionsDialog } from './components/options-dialog';
import { DialogService } from './services/dialog-service';
import { InfoService } from './services/info-service';
import { InfoPanel } from './components/info-panel';
import { InfoDialog } from './components/info-dialog';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { QueuePanel } from './components/queue-panel';
import { PerfPanel } from './components/perf-panel';
import { TimeBarPanel } from './components/timebar-panel';
import { LogoPanel } from './components/logo-panel';
import { OptionsPanel } from './components/options-panel';
import { FullscreenPanel } from './components/fullscreen-panel';

export const App: m.ClosureComponent = () => {
  // Services - initialized during bootstrap, then stable
  let configService: ConfigService;
  let optionsService: OptionsService;
  let capabilitiesService: CapabilitiesService;
  let omService: OmService;
  let queueService: QueueService;
  let renderService: RenderService;
  let timestepService: TimestepService;
  let slotService: SlotService;
  let keyboardService: KeyboardService;
  let paletteService: PaletteService;
  let dialogService: DialogService;
  let infoService: InfoService;
  let themeService: ThemeService;

  return {
    async oninit() {
      // Hide preload message now that app is taking over
      document.getElementById('preload')?.classList.add('hidden');

      const canvas = document.getElementById('globe') as HTMLCanvasElement;
      if (!canvas) {
        BootstrapService.setError('Canvas element #globe not found');
        return;
      }

      // Initialize foundation services
      configService = new ConfigService();
      await configService.init();
      optionsService = new OptionsService(configService);
      omService = new OmService();
      paletteService = new PaletteService();
      dialogService = new DialogService();
      infoService = new InfoService();
      themeService = new ThemeService();
      themeService.init();
      await infoService.init();  // TODO: Should get its own step

      m.redraw();

      try {
        // Step 1: Capabilities
        BootstrapService.setStep('CAPABILITIES');
        capabilitiesService = new CapabilitiesService();
        await capabilitiesService.init();

        // Step 2: Config
        BootstrapService.setStep('CONFIG');
        await optionsService.load();

        // Step 3: Discovery (via TimestepService)
        BootstrapService.setStep('DISCOVERY');
        timestepService = new TimestepService(configService);
        await timestepService.initialize();

        // Step 3b: Sanitize options (snap time to closest available timestep)
        optionsService.sanitize((time) => timestepService.getClosestTimestep(time));

        // Step 4: Assets via QueueService (all files in one batch)
        BootstrapService.setStep('ASSETS');
        queueService = new QueueService(omService, optionsService, configService);
        const f16 = !capabilitiesService.float32_filterable;
        const suffix = f16 ? '-16' : '';

        // Collect results as files complete
        const lutBuffers: ArrayBuffer[] = [];
        const basemapBuffers: ArrayBuffer[] = [];
        let wasmBuffer: ArrayBuffer;
        let fontBuffer: ArrayBuffer;
        let gaussianLatsBuffer: ArrayBuffer;
        let ringOffsetsBuffer: ArrayBuffer;
        let logoBuffer: ArrayBuffer;

        const TOTAL_FILES = 14;
        await queueService.submitFileOrders(
          [
            // 0-2: Atmosphere LUTs
            { url: `/atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
            { url: `/atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
            { url: `/atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
            // 3-8: Basemap faces
            // { url: '/images/basemaps/ghs-pop/4096/px.png', size: 2149455 },
            // { url: '/images/basemaps/ghs-pop/4096/nx.png', size: 1975592 },
            // { url: '/images/basemaps/ghs-pop/4096/py.png', size: 2337011 },
            // { url: '/images/basemaps/ghs-pop/4096/ny.png', size: 88036 },
            // { url: '/images/basemaps/ghs-pop/4096/pz.png', size: 2427476 },
            // { url: '/images/basemaps/ghs-pop/4096/nz.png', size: 400639 },
            { url: '/images/basemaps/rtopo2/px.png', size: 111244 },
            { url: '/images/basemaps/rtopo2/nx.png', size: 78946 },
            { url: '/images/basemaps/rtopo2/py.png', size: 215476 },
            { url: '/images/basemaps/rtopo2/ny.png', size: 292274 },
            { url: '/images/basemaps/rtopo2/pz.png', size: 85084 },
            { url: '/images/basemaps/rtopo2/nz.png', size: 59133 },
            // 9: WASM decoder
            { url: '/om-decoder.wasm', size: 2107564 },
            // 10: Font atlas
            { url: '/fonts/plex-mono.png', size: 15926 },
            // 11-12: Gaussian grid LUTs
            { url: '/om1280/gaussian-lats.bin', size: 10240 },
            { url: '/om1280/ring-offsets.bin', size: 10240 },
            // 13: Logo for idle globe
            { url: '/images/hypatia.png', size: 240500 },
          ],
          async (i, buffer) => {
            if (i < 3) lutBuffers.push(buffer);
            else if (i < 9) basemapBuffers.push(buffer);
            else if (i === 9) wasmBuffer = buffer;
            else if (i === 10) fontBuffer = buffer;
            else if (i === 11) gaussianLatsBuffer = buffer;
            else if (i === 12) ringOffsetsBuffer = buffer;
            else if (i === 13) logoBuffer = buffer;
            await BootstrapService.updateProgress(`Loading assets ${i + 1}/${TOTAL_FILES}...`, 15 + (i / TOTAL_FILES) * 5);
          }
        );

        // Process loaded assets
        const basemapFaces = await Promise.all(
          basemapBuffers.map(buf => createImageBitmap(new Blob([buf], { type: 'image/png' })))
        );
        await initOmWasm(wasmBuffer!);
        const fontAtlas = await createImageBitmap(new Blob([fontBuffer!], { type: 'image/png' }));
        const logoImage = await createImageBitmap(new Blob([logoBuffer!], { type: 'image/png' }));
        const gaussianLats = new Float32Array(gaussianLatsBuffer!);
        const ringOffsets = new Uint32Array(ringOffsetsBuffer!);

        // Step 5: GPU Init
        BootstrapService.setStep('GPU_INIT');
        renderService = new RenderService(canvas, optionsService, configService);
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

        // 5d2. Logo for idle globe
        await renderer.loadLogo(logoImage);

        // 5e. Load palettes
        await paletteService.loadPalettes('temp');

        // 5f. Initialize default palette texture
        const tempPalette = paletteService.getPalette('temp');
        const tempTextureData = paletteService.generateTextureData(tempPalette);
        const tempRange = paletteService.getRange(tempPalette);
        renderer.updateTempPalette(tempTextureData);
        renderService.updateTempPalette(tempTextureData, tempRange.min, tempRange.max);

        // Finalize renderer
        renderer.finalize();

        // SlotService - manages timestep data loading
        slotService = new SlotService(
          timestepService,
          renderService,
          queueService,
          optionsService,
          configService,
        );

        // 5g. Load initial timesteps for all enabled weather layers
        await slotService.initialize((param, index, total) => {
          const pct = 50 + (index / total) * 45;  // 50% to 95%
          BootstrapService.updateProgress(`Loading ${param} ${index}/${total}...`, pct);
        });

        // Step 6: Activate
        BootstrapService.setStep('ACTIVATE');
        renderService.start();
        optionsService.enableUrlSync();
        keyboardService = new KeyboardService(optionsService, timestepService);
        setupCameraControls(canvas, renderer.camera, optionsService, configService);

        // Wire up palette reactivity
        effect(() => {
          void paletteService.paletteChanged.value; // Subscribe to changes
          const palette = paletteService.getPalette('temp');
          const textureData = paletteService.generateTextureData(palette);
          const range = paletteService.getRange(palette);
          renderService.updateTempPalette(textureData, range.min, range.max);
        });

        // Note: Pressure layer loading is handled automatically by SlotService
        // when pressure.enabled changes (same as temp)

        BootstrapService.complete();
        canvas.classList.add('ready');
        console.log(`%c[ZERO] Bootstrap complete (${(performance.now() / 1000).toFixed(2)}s)`, 'color: darkgreen; font-weight: bold');
        m.redraw();

        // Expose services for debugging (localhost only)
        if (location.hostname === 'localhost') {
          window.__hypatia = {
            configService,
            optionsService,
            capabilitiesService,
            omService,
            timestepService,
            queueService,
            renderService,
            slotService,
            keyboardService,
            paletteService,
            renderer: renderService.getRenderer(),
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
      const ready = bootstrapState.complete && !bootstrapState.error;

      return [
        m(BootstrapModal, ready ? { optionsService } : {}),
        ...(ready ? [
          m(OptionsDialog, { optionsService, paletteService, dialogService, configService }),
          m(InfoDialog, { infoService, dialogService }),
          m('.ui-container', [
            m(LogoPanel),
            m(LayersPanel, { configService, optionsService }),
            m(TimeCirclePanel, { optionsService }),
            m(QueuePanel, { queueService, optionsService, slotService }),
            m(TimeBarPanel, { optionsService, slotService, timestepService, configService, themeService }),
            m(FullscreenPanel),
            m(OptionsPanel, { optionsService, dialogService }),
            m(InfoPanel, { infoService, dialogService }),
            optionsService.options.value.debug.showPerfPanel && m(PerfPanel, { renderService }),
          ]),
        ] : []),
      ];
    },
  };
};
