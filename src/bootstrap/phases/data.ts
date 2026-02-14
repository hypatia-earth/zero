/**
 * Data Phase - Load initial weather data for enabled layers
 */

import type { QueueService, ISlotService } from '../../services/queue';
import type { Progress } from '../progress';

export async function runDataPhase(
  slotService: ISlotService,
  queueService: QueueService,
  progress: Progress
): Promise<void> {
  // Initialize slots with priority timesteps
  // Callback is prospective: called BEFORE each order with (nextParam, index, total)
  await slotService.initialize(async (layerId, index, total) => {
    await progress.sub(`Loading ${layerId} data...`, index, total);
  });

  // Enable reactive queue mode (after bootstrap loaded priority timesteps)
  queueService.initReactive();
}
