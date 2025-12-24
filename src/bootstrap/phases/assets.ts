/**
 * Assets Phase - Load static files (LUTs, basemap, WASM, fonts, logo)
 */

import type { QueueService } from '../../services/queue-service';
import type { CapabilitiesService } from '../../services/capabilities-service';
import type { Progress } from '../progress';

export interface LoadedAssets {
  lutBuffers: ArrayBuffer[];
  basemapBuffers: ArrayBuffer[];
  wasmBuffer: ArrayBuffer;
  fontBuffer: ArrayBuffer;
  gaussianLatsBuffer: ArrayBuffer;
  ringOffsetsBuffer: ArrayBuffer;
  logoBuffer: ArrayBuffer;
}

export async function runAssetsPhase(
  queueService: QueueService,
  capabilitiesService: CapabilitiesService,
  progress: Progress
): Promise<LoadedAssets> {
  const f16 = !capabilitiesService.float32_filterable;
  const suffix = f16 ? '-16' : '';

  const lutBuffers: ArrayBuffer[] = [];
  const basemapBuffers: ArrayBuffer[] = [];
  let wasmBuffer!: ArrayBuffer;
  let fontBuffer!: ArrayBuffer;
  let gaussianLatsBuffer!: ArrayBuffer;
  let ringOffsetsBuffer!: ArrayBuffer;
  let logoBuffer!: ArrayBuffer;

  const files = [
    // 0-2: Atmosphere LUTs
    { url: `/atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
    { url: `/atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
    { url: `/atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
    // 3-8: Basemap faces
    { url: '/images/basemaps/rtopo2/px.png', size: 111244 },
    { url: '/images/basemaps/rtopo2/nx.png', size: 78946 },
    { url: '/images/basemaps/rtopo2/py.png', size: 215476 },
    { url: '/images/basemaps/rtopo2/ny.png', size: 292274 },
    { url: '/images/basemaps/rtopo2/pz.png', size: 85084 },
    { url: '/images/basemaps/rtopo2/nz.png', size: 59133 },
    // 9: WASM decoder
    { url: '/om-decoder.wasm', size: 2107564 },
    // 10: Font atlas
    { url: '/fonts/plex-mono.png', size: 15926 },
    // 11-12: Gaussian grid LUTs
    { url: '/om1280/gaussian-lats.bin', size: 10240 },
    { url: '/om1280/ring-offsets.bin', size: 10240 },
    // 13: Logo for idle globe
    { url: '/images/hypatia.png', size: 240500 },
  ];

  const TOTAL = files.length;
  const range = progress.getStepRange('ASSETS');

  // Announce before starting
  await progress.announce('Loading atmosphere textures...', range.start);

  await queueService.submitFileOrders(files, async (i, buffer) => {
    // Collect buffers
    if (i < 3) lutBuffers.push(buffer);
    else if (i < 9) basemapBuffers.push(buffer);
    else if (i === 9) wasmBuffer = buffer;
    else if (i === 10) fontBuffer = buffer;
    else if (i === 11) gaussianLatsBuffer = buffer;
    else if (i === 12) ringOffsetsBuffer = buffer;
    else if (i === 13) logoBuffer = buffer;

    // Prospective message for NEXT file
    const pct = range.start + ((i + 1) / TOTAL) * (range.end - range.start);
    const nextMessages = [
      'Loading atmosphere textures...',  // 0
      'Loading atmosphere textures...',  // 1
      'Loading atmosphere textures...',  // 2
      'Loading basemap textures...',     // 3
      'Loading basemap textures...',     // 4
      'Loading basemap textures...',     // 5
      'Loading basemap textures...',     // 6
      'Loading basemap textures...',     // 7
      'Loading basemap textures...',     // 8
      'Loading WASM decoder...',         // 9
      'Loading font atlas...',           // 10
      'Loading grid geometry...',        // 11
      'Loading grid geometry...',        // 12
      'Loading logo...',                 // 13
    ];

    if (i + 1 < TOTAL) {
      await progress.announce(nextMessages[i + 1]!, pct);
    }
  });

  return {
    lutBuffers,
    basemapBuffers,
    wasmBuffer,
    fontBuffer,
    gaussianLatsBuffer,
    ringOffsetsBuffer,
    logoBuffer,
  };
}
