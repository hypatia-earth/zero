/**
 * GPU Init Phase - Initialize Aurora worker with assets
 *
 * Prepares assets as transferables and sends to worker.
 * Worker handles WebGPU initialization.
 */

import type { AuroraProxy, AuroraConfig, AuroraAssets } from '../../services/aurora-proxy';
import type { PaletteService } from '../../services/palette-service';
import type { AboutService } from '../../services/about-service';
import type { OmService } from '../../services/om-service';
import type { OptionsService } from '../../services/options-service';
import type { ConfigService } from '../../services/config-service';
import type { SlotService } from '../../services/slot-service';
import type { Progress } from '../progress';
import type { LoadedAssets } from './assets';
import { isWeatherLayer } from '../../config/types';

export async function runGpuInitPhase(
  canvas: HTMLCanvasElement,
  auroraProxy: AuroraProxy,
  paletteService: PaletteService,
  aboutService: AboutService,
  omService: OmService,
  optionsService: OptionsService,
  configService: ConfigService,
  slotService: SlotService,
  assets: LoadedAssets,
  progress: Progress
): Promise<void> {
  // Prepare Gaussian LUTs
  const gaussianLats = new Float32Array(assets.gaussianLatsBuffer);
  const ringOffsets = new Uint32Array(assets.ringOffsetsBuffer);

  // Pass Gaussian LUTs to SlotService for synthetic data generation
  slotService.setGaussianLats(gaussianLats);

  // Prepare config for worker
  const timeslotsPerLayer = parseInt(optionsService.options.value.gpu.timeslotsPerLayer, 10);
  const resolutionMap = { '1': 1, '2': 2 } as const;
  const pressureResolution = resolutionMap[optionsService.options.value.pressure.resolution];
  const windLineCount = optionsService.options.value.wind.seedCount;
  const readyLayers = configService.getReadyLayers().filter(isWeatherLayer);

  // Build layer configs for worker LayerStore creation
  const layerConfigs = readyLayers
    .map(id => {
      const layer = configService.getLayer(id);
      if (!layer?.slabs || layer.slabs.length === 0) return null;
      return { id, slabs: layer.slabs };
    })
    .filter((cfg): cfg is NonNullable<typeof cfg> => cfg !== null);

  const config: AuroraConfig = {
    cameraConfig: configService.getCameraConfig(),
    timeslotsPerLayer,
    pressureResolution,
    windLineCount,
    readyLayers,
    layerConfigs,
  };

  // Prepare assets for transfer to worker
  await progress.run('Processing textures...', 0.1, async () => {
    // Decode images on main thread (ImageBitmap is transferable)
    const basemapFaces = await Promise.all(
      assets.basemapBuffers.map(buf =>
        createImageBitmap(new Blob([buf], { type: 'image/png' }))
      )
    );
    const fontAtlas = await createImageBitmap(
      new Blob([assets.fontBuffer], { type: 'image/png' })
    );
    const logo = await createImageBitmap(
      new Blob([assets.logoBuffer], { type: 'image/png' })
    );

    const auroraAssets: AuroraAssets = {
      atmosphereLUTs: {
        transmittance: assets.lutBuffers[0]!,
        scattering: assets.lutBuffers[1]!,
        irradiance: assets.lutBuffers[2]!,
      },
      gaussianLats,
      ringOffsets,
      basemapFaces,
      fontAtlas,
      logo,
    };

    // Initialize worker (transfers assets)
    await progress.run('Initializing GPU worker...', 0.4, async () => {
      await auroraProxy.init(canvas, config, auroraAssets);
    });
  });

  // Initialize WASM decoder
  await progress.run('Initializing data decoder...', 0.6, async () => {
    await omService.init(assets.wasmBuffer);
  });

  // Load palettes
  await progress.run('Loading color palettes...', 0.75, async () => {
    await paletteService.loadPalettes('temp');
  });

  // Initialize palette reactivity now that worker is ready
  paletteService.init();

  // Load about content
  await progress.run('Loading about content...', 0.9, async () => {
    await aboutService.init();
  });
}
