/**
 * GPU Init Phase - Initialize Aurora worker with assets
 *
 * Prepares assets as transferables and sends to worker.
 * Worker handles WebGPU initialization.
 */

import type { AuroraService, AuroraConfig, AuroraAssets } from '../../services/aurora-service';
import type { PaletteService } from '../../services/palette-service';
import type { AboutService } from '../../services/about-service';
import type { OmService } from '../../services/queue/om-service';
import type { OptionsService } from '../../services/options-service';
import type { ConfigService } from '../../services/config-service';
import type { LayerService } from '../../services/layer/layer-service';
import type { SlotService } from '../../services/slot-service';
import type { Progress } from '../progress';
import type { LoadedAssets } from './assets';
import { getPublishedParams, MODEL_BUFFER_MB, type TModel } from '../../config/models';

export async function runGpuInitPhase(
  canvas: HTMLCanvasElement,
  auroraService: AuroraService,
  paletteService: PaletteService,
  aboutService: AboutService,
  omService: OmService,
  optionsService: OptionsService,
  configService: ConfigService,
  layerService: LayerService,
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
  const windLineCount = optionsService.options.value.wind.seedCount;
  // Build param configs for worker buffer creation
  // Include all published params so custom layers can use any param at runtime
  const paramModels = new Map<string, TModel>();
  for (const p of getPublishedParams()) {
    paramModels.set(p, 'ecmwf_ifs');
  }
  for (const layer of layerService.getAll()) {
    if (layer.params) {
      for (const ref of layer.params) {
        paramModels.set(ref.param, ref.model);
      }
    }
  }
  // Buffer size from model grid
  const paramConfigs = [...paramModels].map(([param, model]) => ({
    param,
    sizeMB: MODEL_BUFFER_MB[model],
  }));

  const config: AuroraConfig = {
    cameraConfig: configService.getCameraConfig(),
    timeslotsPerLayer,
    windLineCount,
    paramConfigs,
    layers: layerService.getAll().filter(l => l.isBuiltIn),
  };

  // Restore persisted palette selections from options
  paletteService.restoreFromOptions(optionsService.options.value);

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
    const citiesFontAtlas = await createImageBitmap(
      new Blob([assets.citiesFontBuffer], { type: 'image/png' })
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
      cities: {
        data: assets.citiesDataBuffer,
        fontAtlas: citiesFontAtlas,
        metrics: assets.citiesMetricsBuffer,
      },
      layerPalettes: [
        { layerIndex: layerService.getLayerIndex('temp'), slot: 0, paletteId: optionsService.options.value.temp.palette, range: [-40, 50] },
        { layerIndex: layerService.getLayerIndex('rain'), slot: 0, paletteId: 'rain-wet-intensity', range: [0, 50] },
        { layerIndex: layerService.getLayerIndex('rain'), slot: 1, paletteId: 'rain-frozen-intensity' },
      ],
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
