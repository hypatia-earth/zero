/**
 * Bootstrap Orchestrator - Runs all bootstrap phases in sequence
 *
 * Coordinates service creation and phase execution with proper error handling.
 * Populates the provided services container in place.
 */

import m from 'mithril';
import { Progress } from './progress';
import {
  createFoundationServices,
  createTimestepService,
  createQueueService,
  createAuroraService,
  createSlotService,
  createPaletteService,
  type ServiceContainer,
} from './service-container';
import { extractOptionsMeta, defaultOptions } from '../schemas/options.schema';
import {
  runCapabilitiesPhase,
  runConfigPhase,
  runDiscoveryPhase,
  runAssetsPhase,
  runGpuInitPhase,
  runDataPhase,
  runActivatePhase,
} from './phases';

/**
 * Run the full bootstrap sequence
 * @param canvas - The canvas element for rendering
 * @param progress - Progress tracker (created by caller for early subscription)
 * @param services - Container to populate with services
 */
export async function runBootstrap(
  canvas: HTMLCanvasElement,
  progress: Progress,
  services: Partial<ServiceContainer>
): Promise<void> {
  try {
    await runBootstrapInner(canvas, progress, services);
  } catch (err) {
    // Ignore abort errors (e.g., navigation away)
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }

    const message = err instanceof Error
      ? `${err.message || err.name || 'Unknown error'}${err.stack ? '\n' + err.stack.split('\n').slice(1, 6).join('\n') : ''}`
      : String(err);

    progress.setError(message);
    console.error('[ZERO] Bootstrap failed:', err);
  }
}

async function runBootstrapInner(
  canvas: HTMLCanvasElement,
  progress: Progress,
  services: Partial<ServiceContainer>
): Promise<void> {
  // Create foundation services (sync)
  const foundation = createFoundationServices();
  await foundation.configService.init();
  Object.assign(services, foundation);

  m.redraw();

  // Phase 1: Capabilities
  progress.startStep('CAPABILITIES');
  await runCapabilitiesPhase(services.capabilitiesService!, progress);

  // Phase 2: Config
  progress.startStep('CONFIG');
  await runConfigPhase(services.optionsService!, progress);
  await services.layerService!.loadUserLayers();

  // Phase 3: Discovery
  progress.startStep('DISCOVERY');
  services.timestepService = createTimestepService(services.configService!);
  await runDiscoveryPhase(services.timestepService, services.stateService!, progress);

  // Phase 4: Assets
  progress.startStep('ASSETS');
  services.queueService = createQueueService(
    services.omService!,
    services.optionsService!,
    services.stateService!,
    services.configService!,
    services.timestepService,
    services.layerService!
  );
  const assets = await runAssetsPhase(services.queueService, services.capabilitiesService!, progress);

  // Phase 5: GPU Init (worker-based)
  progress.startStep('GPU_INIT');
  services.auroraService = createAuroraService(
    services.stateService!,
    services.configService!,
    services.optionsService!,
    services.perfService!
  );
  services.paletteService = createPaletteService();
  services.slotService = createSlotService(
    services.timestepService,
    services.auroraService,
    services.queueService,
    services.optionsService!,
    services.stateService!,
    services.configService!
  );
  await runGpuInitPhase(
    canvas,
    services.auroraService,
    services.paletteService,
    services.aboutService!,
    services.omService!,
    services.optionsService!,
    services.configService!,
    services.slotService,
    assets,
    progress
  );

  // Send user layers to worker (loaded from IDB in config phase)
  for (const layer of services.layerService!.getUserLayers()) {
    services.auroraService.send({ type: 'registerUserLayer', layer });
  }

  // Phase 6: Data
  progress.startStep('DATA');
  await runDataPhase(services.slotService, services.queueService, services.configService!, progress);

  // Phase 7: Activate
  progress.startStep('ACTIVATE');
  const { keyboardService } = await runActivatePhase(
    services.auroraService,
    services.stateService!,
    services.timestepService,
    progress
  );
  services.keyboardService = keyboardService;

  // Complete
  progress.complete();
  canvas.classList.add('ready');
  console.log(
    `%c[ZERO] Bootstrap complete (${(performance.now() / 1000).toFixed(2)}s)`,
    'color: darkgreen; font-weight: bold'
  );

  // Expose for debugging
  exposeDebugServices(services as ServiceContainer);
}

/**
 * Expose services for debugging (localhost only)
 */
export function exposeDebugServices(services: ServiceContainer): void {
  if (location.hostname !== 'localhost') return;

  window.__hypatia = {
    configService: services.configService,
    optionsService: services.optionsService,
    stateService: services.stateService,
    capabilitiesService: services.capabilitiesService,
    omService: services.omService,
    timestepService: services.timestepService,
    queueService: services.queueService,
    auroraService: services.auroraService,
    slotService: services.slotService,
    keyboardService: services.keyboardService,
    paletteService: services.paletteService,
    dialogService: services.dialogService,
    aboutService: services.aboutService,
    themeService: services.themeService,
    perfService: services.perfService,
    layerService: services.layerService,
    camera: services.auroraService?.getCamera(),
    schema: { extractOptionsMeta, defaultOptions },
  };
}
