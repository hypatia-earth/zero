/**
 * Data Phase - Load initial weather data for enabled layers
 */

import type { QueueService, ISlotService } from '../../services/queue';
import type { ConfigService } from '../../services/config-service';
import type { Progress } from '../progress';

export async function runDataPhase(
  slotService: ISlotService,
  queueService: QueueService,
  configService: ConfigService,
  progress: Progress
): Promise<void> {
  // Initialize slots with priority timesteps
  // Callback is prospective: called BEFORE each order with (nextParam, index, total)
  await slotService.initialize(async (layerId, index, total) => {
    const layer = configService.getLayer(layerId as import('../../config/types').TLayer);
    const label = layer?.label ?? layerId;
    await progress.sub(`Loading ${label} data...`, index, total);
  });

  // Enable reactive queue mode (after bootstrap loaded priority timesteps)
  queueService.initReactive();
}
