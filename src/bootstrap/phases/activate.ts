/**
 * Activate Phase - Start render loop and enable user input
 */

import type { AuroraService } from '../../services/aurora-service';
import type { StateService } from '../../services/state-service';
import { KeyboardService } from '../../services/keyboard-service';
import type { TimestepService } from '../../services/timestep';
import type { Progress } from '../progress';

export interface ActivateResult {
  keyboardService: KeyboardService;
}

export async function runActivatePhase(
  auroraService: AuroraService,
  stateService: StateService,
  timestepService: TimestepService,
  progress: Progress
): Promise<ActivateResult> {
  await progress.run('Starting render loop...', 0, async () => {
    auroraService.start();
  });

  await progress.run('Enabling controls...', 0.5, async () => {
    stateService.enableUrlSync();
  });

  const keyboardService = new KeyboardService(stateService, timestepService);

  return { keyboardService };
}
