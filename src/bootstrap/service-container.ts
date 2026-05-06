/**
 * ServiceContainer - Creates and wires all services
 *
 * Centralizes service instantiation and dependency injection.
 * Handles circular dependencies with post-construction wiring.
 */

import { ConfigService } from '../services/config-service';
import { OptionsService } from '../services/options-service';
import { StateService } from '../services/state-service';
import { OmService } from '../services/queue/om-service';
import { DialogService } from '../services/dialog-service';
import { ModalService } from '../services/modal-service';
import { AboutService } from '../services/about-service';
import { ThemeService } from '../services/theme-service';
import { CapabilitiesService } from '../services/capabilities-service';
import { TimestepService } from '../services/timestep/timestep-service';
import { QueueService } from '../services/queue/queue-service';
import { createAuroraService, type AuroraService } from '../services/aurora-service';
import { SlotService } from '../services/slot-service';
import { PaletteService } from '../services/palette-service';
import { KeyboardService } from '../services/keyboard-service';
import { PerfService } from '../services/perf-service';
import { LayerService } from '../services/layer/layer-service';
import { CaptureService } from '../services/capture/capture-service';
import { TestPerformanceService } from '../services/test-performance-service';
import type { Signal } from '@preact/signals-core';
import type { QueueStats } from '../config/types';

export interface ServiceContainer {
  // Foundation (no service deps)
  layerService: LayerService;
  configService: ConfigService;
  dialogService: DialogService;
  modalService: ModalService;
  aboutService: AboutService;
  themeService: ThemeService;
  capabilitiesService: CapabilitiesService;
  perfService: PerfService;

  // Config-dependent
  optionsService: OptionsService;
  stateService: StateService;
  omService: OmService;
  timestepService: TimestepService;

  // Data management
  queueService: QueueService;

  // Rendering (worker-based)
  auroraService: AuroraService | null;
  slotService: SlotService | null;
  paletteService: PaletteService | null;

  // Input (created after rendering)
  keyboardService: KeyboardService | null;

  // Camera capture
  captureService: CaptureService;

  // Performance testing
  testPerformanceService: TestPerformanceService;
}

/**
 * Create foundation services (no async, no canvas needed)
 */
export function createFoundationServices(): Pick<
  ServiceContainer,
  'layerService' | 'configService' | 'dialogService' | 'modalService' | 'aboutService' | 'themeService' | 'capabilitiesService' |
  'optionsService' | 'stateService' | 'omService' | 'perfService'
> {
  const layerService = new LayerService();
  const configService = new ConfigService();
  const optionsService = new OptionsService();
  const stateService = new StateService(configService);

  const omService = new OmService(optionsService);
  const dialogService = new DialogService();
  const modalService = new ModalService();
  const aboutService = new AboutService();
  const themeService = new ThemeService();
  const capabilitiesService = new CapabilitiesService();
  const perfService = new PerfService();

  // Register built-in layers and wire dependencies
  layerService.registerBuiltInLayers();
  layerService.setStateService(stateService);
  stateService.setLayerService(layerService);

  return {
    layerService,
    configService,
    optionsService,
    stateService,
    omService,
    dialogService,
    modalService,
    aboutService,
    themeService,
    capabilitiesService,
    perfService,
  };
}

/**
 * Create TimestepService (needs layer service)
 */
export function createTimestepService(layerService: LayerService): TimestepService {
  return new TimestepService(layerService);
}

/**
 * Create QueueService (needs multiple services)
 */
export function createQueueService(
  omService: OmService,
  auroraService: AuroraService,
  optionsService: OptionsService,
  stateService: StateService,
  timestepService: TimestepService,
  layerService: LayerService,
  perfService: PerfService
): QueueService {
  return new QueueService(omService, auroraService, optionsService, stateService, timestepService, layerService, perfService);
}

// AuroraService is created via createAuroraService from aurora-service.ts
export { createAuroraService };

/**
 * Create SlotService and wire circular dep with QueueService
 */
export function createSlotService(
  timestepService: TimestepService,
  auroraService: AuroraService,
  queueService: QueueService,
  stateService: StateService,
  layerService: LayerService
): SlotService {
  const slotService = new SlotService(
    timestepService,
    auroraService,
    queueService,
    stateService,
    layerService
  );

  // Wire circular dep: QueueService needs to deliver data to SlotService
  queueService.setSlotService(slotService);

  return slotService;
}

/**
 * Create PaletteService
 */
export function createPaletteService(): PaletteService {
  return new PaletteService();
}

/**
 * Create KeyboardService (needs state + timestep services)
 */
export function createKeyboardService(
  stateService: StateService,
  timestepService: TimestepService
): KeyboardService {
  return new KeyboardService(stateService, timestepService);
}

/**
 * Create CaptureService (all deps available after GPU init)
 */
export function createCaptureService(
  optionsService: OptionsService,
  stateService: StateService,
  queueStats: Signal<QueueStats>,
  auroraService: AuroraService,
  queueService: QueueService,
  timestepService: TimestepService
): CaptureService {
  return new CaptureService(optionsService, stateService, queueStats, auroraService, queueService, timestepService);
}
