/**
 * Config Phase - Load user options from IndexedDB
 */

import type { OptionsService } from '../../services/options-service';
import type { Progress } from '../progress';

export async function runConfigPhase(
  optionsService: OptionsService,
  progress: Progress
): Promise<void> {
  await progress.run('Loading user preferences...', 0, async () => {
    await optionsService.load();
  });
}
