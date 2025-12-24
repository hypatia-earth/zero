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
import { QueueService } from '../services/queue-service';
import { RenderService } from '../services/render-service';
import { SlotService } from '../services/slot-service';
import { PaletteService } from '../services/palette-service';
import { KeyboardService } from '../services/keyboard-service';

export interface ServiceContainer {
  // Foundation (no service deps)
  configService: ConfigService;
  dialogService: DialogService;
  aboutService: AboutService;
  themeService: ThemeService;
  capabilitiesService: CapabilitiesService;

  // Config-dependent
  optionsService: OptionsService;
  stateService: StateService;
  omService: OmService;
  timestepService: TimestepService;

  // Data management
  queueService: QueueService;

  // Rendering (created later, needs canvas)
  renderService: RenderService | null;
  slotService: SlotService | null;
  paletteService: PaletteService | null;

  // Input (created after rendering)
  keyboardService: KeyboardService | null;
}

/**
 * Create foundation services (no async, no canvas needed)
 */
export function createFoundationServices(): Pick<
  ServiceContainer,
  'configService' | 'dialogService' | 'aboutService' | 'themeService' | 'capabilitiesService' |
  'optionsService' | 'stateService' | 'omService'
> {
  const configService = new ConfigService();
  const optionsService = new OptionsService(configService);
  // StateService uses effect-based decoupling: watches optionsService.options signal
  const stateService = new StateService(configService, optionsService);

  const omService = new OmService(optionsService);
  const dialogService = new DialogService();
  const aboutService = new AboutService();
  const themeService = new ThemeService();
  const capabilitiesService = new CapabilitiesService();

  return {
    configService,
    optionsService,
    stateService,
    omService,
    dialogService,
    aboutService,
    themeService,
    capabilitiesService,
  };
}

/**
 * Create TimestepService (needs config initialized)
 */
export function createTimestepService(configService: ConfigService): TimestepService {
  return new TimestepService(configService);
}

/**
 * Create QueueService (needs multiple services)
 */
export function createQueueService(
  omService: OmService,
  optionsService: OptionsService,
  stateService: StateService,
  configService: ConfigService,
  timestepService: TimestepService
): QueueService {
  return new QueueService(omService, optionsService, stateService, configService, timestepService);
}

/**
 * Create RenderService (needs canvas element)
 */
export function createRenderService(
  canvas: HTMLCanvasElement,
  optionsService: OptionsService,
  stateService: StateService,
  configService: ConfigService
): RenderService {
  return new RenderService(canvas, optionsService, stateService, configService);
}

/**
 * Create SlotService and wire circular dep with QueueService
 */
export function createSlotService(
  timestepService: TimestepService,
  renderService: RenderService,
  queueService: QueueService,
  optionsService: OptionsService,
  stateService: StateService,
  configService: ConfigService
): SlotService {
  const slotService = new SlotService(
    timestepService,
    renderService,
    queueService,
    optionsService,
    stateService,
    configService
  );

  // Wire circular dep: QueueService needs to deliver data to SlotService
  queueService.setSlotService(slotService);

  return slotService;
}

/**
 * Create PaletteService (needs renderService)
 */
export function createPaletteService(renderService: RenderService): PaletteService {
  return new PaletteService(renderService);
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
