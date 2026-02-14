/**
 * Assets Phase - Load static files (LUTs, basemap, WASM, fonts, logo)
 */

import type { QueueService } from '../../services/queue/queue-service';
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

  const base = import.meta.env.BASE_URL;
  const files = [
    // 0-2: Atmosphere LUTs
    { url: `${base}atmosphere/transmittance${suffix}.dat`, size: f16 ? 131072 : 262144 },
    { url: `${base}atmosphere/scattering${suffix}.dat`, size: f16 ? 8388608 : 16777216 },
    { url: `${base}atmosphere/irradiance${suffix}.dat`, size: f16 ? 8192 : 16384 },
    // 3-8: Basemap faces
    { url: `${base}images/basemaps/rtopo2/px.png`, size: 111244 },
    { url: `${base}images/basemaps/rtopo2/nx.png`, size: 78946 },
    { url: `${base}images/basemaps/rtopo2/py.png`, size: 215476 },
    { url: `${base}images/basemaps/rtopo2/ny.png`, size: 292274 },
    { url: `${base}images/basemaps/rtopo2/pz.png`, size: 85084 },
    { url: `${base}images/basemaps/rtopo2/nz.png`, size: 59133 },
    // 9: WASM decoder
    { url: `${base}om-decoder.wasm`, size: 2107564 },
    // 10: Font atlas
    { url: `${base}fonts/plex-mono.png`, size: 15926 },
    // 11-12: Gaussian grid LUTs
    { url: `${base}om1280/gaussian-lats.bin`, size: 10240 },
    { url: `${base}om1280/ring-offsets.bin`, size: 10240 },
    // 13: Logo for idle globe
    { url: `${base}images/hypatia.png`, size: 240500 },
  ];

  const TOTAL = files.length;

  // Prospective messages for each file group
  const getNextMessage = (i: number): string => {
    if (i < 3) return 'Loading atmosphere textures...';
    if (i < 9) return 'Loading basemap textures...';
    if (i === 9) return 'Loading WASM decoder...';
    if (i === 10) return 'Loading font atlas...';
    if (i < 13) return 'Loading grid geometry...';
    return 'Loading logo...';
  };

  // Announce first file
  await progress.sub(getNextMessage(0), 0, TOTAL);

  await queueService.submitFileOrders(files, async (i, buffer) => {
    // Collect buffers
    if (i < 3) lutBuffers.push(buffer);
    else if (i < 9) basemapBuffers.push(buffer);
    else if (i === 9) wasmBuffer = buffer;
    else if (i === 10) fontBuffer = buffer;
    else if (i === 11) gaussianLatsBuffer = buffer;
    else if (i === 12) ringOffsetsBuffer = buffer;
    else if (i === 13) logoBuffer = buffer;

    // Announce next file (prospective)
    if (i + 1 < TOTAL) {
      await progress.sub(getNextMessage(i + 1), i + 1, TOTAL);
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
