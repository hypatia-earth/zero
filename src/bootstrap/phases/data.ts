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
  // Callback is prospective: called BEFORE each order with (nextParam, index, total)
  await slotService.initialize(async (nextParam, index, total) => {
    const paramLabel = nextParam.charAt(0).toUpperCase() + nextParam.slice(1);
    await progress.sub(`Loading ${paramLabel} data...`, index, total);
  });

  // Enable reactive queue mode (after bootstrap loaded priority timesteps)
  queueService.initReactive();
}
