/**
 * GPU Init Phase - Initialize Aurora worker with assets
 *
 * Prepares assets as transferables and sends to worker.
 * Worker handles WebGPU initialization.
 */

import type { AuroraService, AuroraConfig, AuroraAssets } from '../../services/aurora-service';
import type { PaletteService } from '../../services/palette-service';
import type { AboutService } from '../../services/about-service';
import type { OmService } from '../../services/om-service';
import type { OptionsService } from '../../services/options-service';
import type { ConfigService } from '../../services/config-service';
import type { LayerService } from '../../services/layer-service';
import type { ISlotService } from '../../services/queue-service';
import type { Progress } from '../progress';
import type { LoadedAssets } from './assets';
import { isWeatherLayer } from '../../config/types';

export async function runGpuInitPhase(
  canvas: HTMLCanvasElement,
  auroraService: AuroraService,
  paletteService: PaletteService,
  aboutService: AboutService,
  omService: OmService,
  optionsService: OptionsService,
  configService: ConfigService,
  layerService: LayerService,
  slotService: ISlotService,
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
  const windLineCount = optionsService.options.value.wind.seedCount;
  const readyLayers = configService.getReadyLayers().filter(isWeatherLayer);

  // Build layer configs for worker LayerStore creation (legacy mode)
  const layerConfigs = readyLayers
    .map(id => {
      const layer = configService.getLayer(id);
      if (!layer?.slabs || layer.slabs.length === 0) return null;
      return { id, slabs: layer.slabs };
    })
    .filter((cfg): cfg is NonNullable<typeof cfg> => cfg !== null);

  // Build param configs for worker ParamStore creation
  const paramSet = new Set<string>();
  for (const layer of layerService.getBuiltIn()) {
    if (layer.params) {
      for (const param of layer.params) {
        paramSet.add(param);
      }
    }
  }
  // Each param gets 26MB buffer (standard weather data size)
  const paramConfigs = [...paramSet].map(param => ({ param, sizeMB: 26 }));

  const config: AuroraConfig = {
    cameraConfig: configService.getCameraConfig(),
    timeslotsPerLayer,
    windLineCount,
    readyLayers,
    layerConfigs,
    paramConfigs,
  };

  // Load palettes first (needed for worker assets)
  await progress.run('Loading color palettes...', 0.05, async () => {
    await paletteService.loadPalettes('temp');
    const persistedPalette = optionsService.options.value.temp.palette;
    paletteService.setPalette('temp', persistedPalette);
  });

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

    // Convert palettes array to Record for worker
    const tempPalettes = Object.fromEntries(
      paletteService.getPalettes('temp').map(p => [p.name, p])
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
      tempPalettes,
    };

    // Initialize worker (transfers assets)
    await progress.run('Initializing GPU worker...', 0.4, async () => {
      await auroraService.init(canvas, config, auroraAssets);
    });
  });

  // Initialize WASM decoder
  await progress.run('Initializing data decoder...', 0.6, async () => {
    await omService.init(assets.wasmBuffer);
  });

  // Load about content
  await progress.run('Loading about content...', 0.9, async () => {
    await aboutService.init();
  });
}
