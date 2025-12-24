/**
 * Bootstrap Orchestrator - Runs all bootstrap phases in sequence
 *
 * Coordinates service creation and phase execution with proper error handling.
 * Returns fully initialized services ready for rendering.
 */

import m from 'mithril';
import { Progress } from './progress';
import {
  createFoundationServices,
  createTimestepService,
  createQueueService,
  createRenderService,
  createSlotService,
  createPaletteService,
  type ServiceContainer,
} from './service-container';
import {
  runCapabilitiesPhase,
  runConfigPhase,
  runDiscoveryPhase,
  runAssetsPhase,
  runGpuInitPhase,
  runDataPhase,
  runActivatePhase,
} from './phases';
import { KeyboardService } from '../services/keyboard-service';

export interface BootstrapResult {
  services: ServiceContainer;
}

/**
 * Run the full bootstrap sequence
 * @param canvas - The canvas element for rendering
 * @param progress - Progress tracker (created by caller for early subscription)
 */
export async function runBootstrap(
  canvas: HTMLCanvasElement,
  progress: Progress
): Promise<BootstrapResult> {

  // Create foundation services (sync)
  const foundation = createFoundationServices();
  await foundation.configService.init();

  // Build partial container
  const services: ServiceContainer = {
    ...foundation,
    timestepService: null as unknown as ServiceContainer['timestepService'],
    queueService: null as unknown as ServiceContainer['queueService'],
    renderService: null,
    slotService: null,
    paletteService: null,
    keyboardService: null,
  };

  m.redraw();

  // Phase 1: Capabilities
  progress.setStep('CAPABILITIES', 'Checking browser capabilities...');
  await runCapabilitiesPhase(services.capabilitiesService, progress);

  // Phase 2: Config
  progress.setStep('CONFIG', 'Loading configuration...');
  await runConfigPhase(services.optionsService, progress);

  // Phase 3: Discovery
  progress.setStep('DISCOVERY', 'Discovering available data...');
  services.timestepService = createTimestepService(services.configService);
  await runDiscoveryPhase(services.timestepService, services.stateService, progress);

  // Phase 4: Assets
  progress.setStep('ASSETS', 'Loading static assets...');
  services.queueService = createQueueService(
    services.omService,
    services.optionsService,
    services.stateService,
    services.configService,
    services.timestepService
  );
  const assets = await runAssetsPhase(services.queueService, services.capabilitiesService, progress);

  // Phase 5: GPU Init
  progress.setStep('GPU_INIT', 'Initializing graphics...');
  services.renderService = createRenderService(
    canvas,
    services.optionsService,
    services.stateService,
    services.configService
  );
  services.paletteService = createPaletteService(services.renderService);
  await runGpuInitPhase(
    services.renderService,
    services.paletteService,
    services.aboutService,
    services.omService,
    assets,
    progress
  );

  // Phase 6: Data
  progress.setStep('DATA', 'Loading weather data...');
  services.slotService = createSlotService(
    services.timestepService,
    services.renderService,
    services.queueService,
    services.optionsService,
    services.stateService,
    services.configService
  );
  await runDataPhase(services.slotService, services.queueService, progress);

  // Phase 7: Activate
  progress.setStep('ACTIVATE', 'Starting application...');
  const { keyboardService } = await runActivatePhase(
    canvas,
    services.renderService,
    services.stateService,
    services.configService,
    KeyboardService,
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

  return { services };
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
    renderService: services.renderService,
    slotService: services.slotService,
    keyboardService: services.keyboardService,
    paletteService: services.paletteService,
    dialogService: services.dialogService,
    aboutService: services.aboutService,
    themeService: services.themeService,
    renderer: services.renderService?.getRenderer(),
  };
}
