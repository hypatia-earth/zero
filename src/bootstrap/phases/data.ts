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
  // Initialize slots with priority timesteps
  await slotService.initialize(async (param, index, total) => {
    const paramLabel = param.charAt(0).toUpperCase() + param.slice(1);
    await progress.sub(`Loading ${paramLabel} data (${index}/${total})...`, index, total);
  });

  // Enable reactive queue mode (after bootstrap loaded priority timesteps)
  queueService.initReactive();
}
