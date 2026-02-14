/**
 * ServiceContainer - Creates and wires all services
 *
 * Centralizes service instantiation and dependency injection.
 * Handles circular dependencies with post-construction wiring.
 */

import { ConfigService } from '../services/config-service';
import { OptionsService } from '../services/options-service';
import { StateService } from '../services/state-service';
import { OmService } from '../services/om-service';
import { DialogService } from '../services/dialog-service';
import { AboutService } from '../services/about-service';
import { ThemeService } from '../services/theme-service';
import { CapabilitiesService } from '../services/capabilities-service';
import { TimestepService } from '../services/timestep-service';
import { QueueService, type ISlotService } from '../services/queue-service';
import { createAuroraService, type AuroraService } from '../services/aurora-service';
import { ParamSlotService } from '../services/param-slot-service';
import { PaletteService } from '../services/palette-service';
import { KeyboardService } from '../services/keyboard-service';
import { PerfService } from '../services/perf-service';
import { LayerService } from '../services/layer-service';
import { registerBuiltInLayers } from '../layers';

export interface ServiceContainer {
  // Foundation (no service deps)
  layerService: LayerService;
  configService: ConfigService;
  dialogService: DialogService;
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
  slotService: ISlotService | null;
  paletteService: PaletteService | null;

  // Input (created after rendering)
  keyboardService: KeyboardService | null;
}

/**
 * Create foundation services (no async, no canvas needed)
 */
export function createFoundationServices(): Pick<
  ServiceContainer,
  'layerService' | 'configService' | 'dialogService' | 'aboutService' | 'themeService' | 'capabilitiesService' |
  'optionsService' | 'stateService' | 'omService' | 'perfService'
> {
  const layerService = new LayerService();
  const configService = new ConfigService();
  configService.setLayerService(layerService);
  const optionsService = new OptionsService(configService);
  // StateService uses effect-based decoupling: watches optionsService.options signal
  const stateService = new StateService(configService, optionsService);

  const omService = new OmService(optionsService);
  const dialogService = new DialogService();
  const aboutService = new AboutService();
  const themeService = new ThemeService();
  const capabilitiesService = new CapabilitiesService();
  const perfService = new PerfService();

  // Register built-in layers
  registerBuiltInLayers(layerService);

  return {
    layerService,
    configService,
    optionsService,
    stateService,
    omService,
    dialogService,
    aboutService,
    themeService,
    capabilitiesService,
    perfService,
  };
}

/**
 * Create TimestepService (needs config and layer services)
 */
export function createTimestepService(configService: ConfigService, layerService: LayerService): TimestepService {
  return new TimestepService(configService, layerService);
}

/**
 * Create QueueService (needs multiple services)
 */
export function createQueueService(
  omService: OmService,
  optionsService: OptionsService,
  stateService: StateService,
  configService: ConfigService,
  timestepService: TimestepService,
  layerService: LayerService
): QueueService {
  return new QueueService(omService, optionsService, stateService, configService, timestepService, layerService);
}

// AuroraService is created via createAuroraService from aurora-service.ts
export { createAuroraService };

/**
 * Create SlotService (or ParamSlotService) and wire circular dep with QueueService
 */
export function createSlotService(
  timestepService: TimestepService,
  auroraService: AuroraService,
  queueService: QueueService,
  optionsService: OptionsService,
  stateService: StateService,
  configService: ConfigService,
  layerService: LayerService
): ISlotService {
  const slotService = new ParamSlotService(
    timestepService,
    auroraService,
    queueService,
    optionsService,
    stateService,
    configService,
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
