/**
 * Data Phase - Load initial weather data for enabled layers
 */

import type { SlotService } from '../../services/slot-service';
import type { QueueService } from '../../services/queue-service';
import type { Progress } from '../progress';

export async function runDataPhase(
  slotService: SlotService,
  queueService: QueueService,
  progress: Progress
): Promise<void> {
  const range = progress.getStepRange('DATA');

  // Initialize slots with priority timesteps
  await slotService.initialize(async (param, index, total) => {
    const pct = range.start + (index / total) * (range.end - range.start);
    // Prospective: tell user what's being loaded
    const paramLabel = param.charAt(0).toUpperCase() + param.slice(1);
    await progress.announce(`Loading ${paramLabel} data (${index}/${total})...`, pct);
  });

  // Enable reactive queue mode (after bootstrap loaded priority timesteps)
  queueService.initReactive();
}
