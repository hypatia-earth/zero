/**
 * Capabilities Phase - Check browser capabilities (WebGPU, etc.)
 */

import type { CapabilitiesService } from '../../services/capabilities-service';
import type { Progress } from '../progress';

export async function runCapabilitiesPhase(
  capabilitiesService: CapabilitiesService,
  progress: Progress
): Promise<void> {
  await progress.run('Checking WebGPU support...', 0, async () => {
    await capabilitiesService.init();
  });
}
