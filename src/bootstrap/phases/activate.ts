/**
 * Activate Phase - Start render loop and enable user input
 */

import type { RenderService } from '../../services/render-service';
import type { StateService } from '../../services/state-service';
import type { KeyboardService } from '../../services/keyboard-service';
import type { ConfigService } from '../../services/config-service';
import type { TimestepService } from '../../services/timestep-service';
import type { Progress } from '../progress';
import { setupCameraControls } from '../../services/camera-controls';

export interface ActivateResult {
  keyboardService: KeyboardService;
}

export async function runActivatePhase(
  canvas: HTMLCanvasElement,
  renderService: RenderService,
  stateService: StateService,
  configService: ConfigService,
  KeyboardServiceClass: typeof KeyboardService,
  timestepService: TimestepService,
  progress: Progress
): Promise<ActivateResult> {
  await progress.run('Starting render loop...', 0, async () => {
    renderService.start();
  });

  await progress.run('Enabling controls...', 0.5, async () => {
    stateService.enableUrlSync();
  });

  const keyboardService = new KeyboardServiceClass(stateService, timestepService);
  setupCameraControls(canvas, renderService.getRenderer().camera, stateService, configService);

  return { keyboardService };
}
