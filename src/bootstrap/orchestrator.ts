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
  createCaptureService,
  type ServiceContainer,
} from './service-container';
import { extractOptionsMeta, defaultOptions } from '../schemas/options.schema';
import { buildUserLayerOptions } from '../services/layer/layer-service';
import {
  runCapabilitiesPhase,
  runConfigPhase,
  runDiscoveryPhase,
  runAssetsPhase,
  runGpuInitPhase,
  runDataPhase,
  runActivatePhase,
} from './phases';
import type { ConfigService } from '../services/config-service';
import { TestPerformanceService } from '../services/test-performance-service';

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

    const errorSnippet = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    sendBeacon(services.configService, 'error', undefined, errorSnippet);
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
  services.timestepService = createTimestepService(services.layerService!);
  services.stateService!.setTimestepService(services.timestepService);
  await runDiscoveryPhase(services.timestepService, services.stateService!, progress);

  // Phase 4: Assets
  progress.startStep('ASSETS');
  services.queueService = createQueueService(
    services.omService!,
    services.optionsService!,
    services.stateService!,
    services.timestepService,
    services.layerService!
  );
  const assets = await runAssetsPhase(services.queueService, services.capabilitiesService!, progress);

  // Phase 5: GPU Init (worker-based)
  progress.startStep('GPU_INIT');
  services.paletteService = createPaletteService();
  services.auroraService = createAuroraService(
    services.stateService!,
    services.configService!,
    services.optionsService!,
    services.perfService!
  );
  services.slotService = createSlotService(
    services.timestepService,
    services.auroraService,
    services.queueService,
    services.optionsService!,
    services.stateService!,
    services.layerService!
  );
  await runGpuInitPhase(
    canvas,
    services.auroraService,
    services.paletteService,
    services.aboutService!,
    services.omService!,
    services.optionsService!,
    services.configService!,
    services.layerService!,
    services.slotService,
    assets,
    progress
  );

  // Capture service — all deps available after GPU init
  services.captureService = createCaptureService(
    foundation.optionsService,
    foundation.stateService,
    services.queueService.queueStats,
    services.auroraService,
    services.queueService,
    services.timestepService
  );

  // Send custom layers to worker (loaded from IDB in config phase, enabled state set by sanitize)
  for (const layer of services.layerService!.getAll().filter(l => !l.isBuiltIn)) {
    services.auroraService.send({ type: 'registerUserLayer', layer });
    if (layer.userLayerIndex !== undefined) {
      const enabled = services.layerService!.isLayerEnabled(layer.id);
      services.auroraService.send(buildUserLayerOptions(layer, enabled));
    }
  }

  // Phase 6: Data
  progress.startStep('DATA');
  await runDataPhase(services.slotService, services.queueService, progress);

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

  const bootSeconds = (performance.now() / 1000).toFixed(2);
  console.log(
    `%c[ZERO] Bootstrap complete (${bootSeconds}s)`,
    'color: darkgreen; font-weight: bold'
  );

  sendBeacon(services.configService!, 'ok', bootSeconds);

  // Performance test service
  const testPerfService = new TestPerformanceService(
    foundation.optionsService,
    services.auroraService
  );
  (services as any).testPerformanceService = testPerfService;
  // Delay to let UI mount and perf panel render after bootstrap dialog closes
  setTimeout(() => testPerfService.autoRun(), 1000);

  // Expose for debugging
  exposeDebugServices(services as ServiceContainer);
}

/**
 * Fire-and-forget beacon after bootstrap (success or error)
 */
function sendBeacon(
  configService: ConfigService | undefined,
  status: 'ok' | 'error',
  bootTime?: string,
  error?: string
): void {
  const config = configService?.getConfig();
  if (!config?.beacon) return;

  const params = new URLSearchParams({
    s: status,
    v: __APP_VERSION__,
  });
  if (bootTime) params.set('t', bootTime);
  if (error) params.set('e', error);

  navigator.sendBeacon(`${config.beaconUrl}?${params}`);
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
    modalService: services.modalService,
    aboutService: services.aboutService,
    themeService: services.themeService,
    perfService: services.perfService,
    layerService: services.layerService,
    captureService: services.captureService,
    testPerformanceService: services.testPerformanceService,
    camera: services.auroraService?.getCamera(),
    schema: { extractOptionsMeta, defaultOptions },
  };
}
