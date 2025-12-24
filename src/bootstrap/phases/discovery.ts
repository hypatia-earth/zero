/**
 * Discovery Phase - Register service worker and discover available timesteps
 */

import type { TimestepService } from '../../services/timestep-service';
import type { StateService } from '../../services/state-service';
import type { Progress } from '../progress';
import { registerServiceWorker } from '../../services/sw-registration';

export async function runDiscoveryPhase(
  timestepService: TimestepService,
  stateService: StateService,
  progress: Progress
): Promise<void> {
  // Register service worker
  await progress.run('Registering service worker...', 10, async () => {
    await registerServiceWorker();
  });

  // Discover available timesteps
  await timestepService.initialize(async (step, detail) => {
    const messages: Record<string, string> = {
      manifest: 'Fetching data manifest...',
      runs: 'Discovering model runs...',
      cache: `Checking cache: ${detail}...`,
    };
    await progress.announce(messages[step] ?? `Discovery: ${step}...`, 12);
  });

  // Snap time to closest available timestep
  await progress.run('Synchronizing time...', 18, async () => {
    stateService.sanitize((time: Date) => timestepService.getClosestTimestep(time));
    stateService.delegateLayers();
  });
}
