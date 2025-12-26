/**
 * Discovery Phase - Register service worker and discover available timesteps
 */

import type { TimestepService } from '../../services/timestep-service';
import type { StateService } from '../../services/state-service';
import type { Progress } from '../progress';
import { registerServiceWorker, getPrefetchHistory } from '../../services/sw-registration';

export async function runDiscoveryPhase(
  timestepService: TimestepService,
  stateService: StateService,
  progress: Progress
): Promise<void> {
  // Register service worker
  await progress.run('Registering service worker...', 0, async () => {
    await registerServiceWorker();

    // Log last prefetch (non-blocking)
    getPrefetchHistory().then(history => {
      if (history.length > 0) {
        const last = history[0]!;
        const date = new Date(last.timestamp);
        const ago = Math.round((Date.now() - date.getTime()) / 3600000);
        console.log(`[Prefetch] Last: ${ago}h ago, ${last.success}/${last.totalFiles} OK, ${last.layers.join('+')}`);
      }
    }).catch(() => {});
  });

  // Discover available timesteps
  await timestepService.initialize(async (step, detail) => {
    const messages: Record<string, string> = {
      manifest: 'Fetching data manifest...',
      runs: 'Discovering model runs...',
      cache: `Checking cache: ${detail}...`,
    };
    const fractions: Record<string, number> = {
      manifest: 0.2,
      runs: 0.5,
      cache: 0.7,
    };
    await progress.sub(messages[step] ?? `Discovery: ${step}...`, fractions[step] ?? 0.5);
  });

  // Snap time to closest available timestep
  await progress.run('Synchronizing time...', 0.9, async () => {
    stateService.sanitize((time: Date) => timestepService.getClosestTimestep(time));
    stateService.delegateLayers();
  });
}
