/**
 * GPU Init Phase - Initialize WebGPU renderer and upload assets
 */

import type { RenderService } from '../../services/render-service';
import type { PaletteService } from '../../services/palette-service';
import type { AboutService } from '../../services/about-service';
import type { OmService } from '../../services/om-service';
import type { Progress } from '../progress';
import type { LoadedAssets } from './assets';

export async function runGpuInitPhase(
  renderService: RenderService,
  createPaletteService: (rs: RenderService) => PaletteService,
  aboutService: AboutService,
  omService: OmService,
  assets: LoadedAssets,
  progress: Progress
): Promise<PaletteService> {
  // Initialize WebGPU
  await progress.run('Requesting GPU adapter...', 0, async () => {
    const gaussianLats = new Float32Array(assets.gaussianLatsBuffer);
    const ringOffsets = new Uint32Array(assets.ringOffsetsBuffer);
    await renderService.initialize(gaussianLats, ringOffsets);
  });

  // Create PaletteService after renderer is initialized (effect needs renderer)
  const paletteService = createPaletteService(renderService);

  const renderer = renderService.getRenderer();

  // Upload atmosphere LUTs
  await progress.run('Uploading atmosphere textures...', 0.15, async () => {
    renderer.createAtmosphereTextures({
      transmittance: assets.lutBuffers[0]!,
      scattering: assets.lutBuffers[1]!,
      irradiance: assets.lutBuffers[2]!,
    });
  });

  // Load basemap
  await progress.run('Processing basemap textures...', 0.3, async () => {
    const basemapFaces = await Promise.all(
      assets.basemapBuffers.map(buf =>
        createImageBitmap(new Blob([buf], { type: 'image/png' }))
      )
    );
    await renderer.loadBasemap(basemapFaces);
  });

  // Load font atlas
  await progress.run('Loading font atlas...', 0.5, async () => {
    const fontAtlas = await createImageBitmap(
      new Blob([assets.fontBuffer], { type: 'image/png' })
    );
    await renderer.loadFontAtlas(fontAtlas);
  });

  // Load logo
  await progress.run('Loading logo...', 0.6, async () => {
    const logoImage = await createImageBitmap(
      new Blob([assets.logoBuffer], { type: 'image/png' })
    );
    await renderer.loadLogo(logoImage);
  });

  // Initialize WASM decoder
  await progress.run('Initializing data decoder...', 0.7, async () => {
    await omService.init(assets.wasmBuffer);
  });

  // Load palettes
  await progress.run('Loading color palettes...', 0.85, async () => {
    await paletteService.loadPalettes('temp');
  });

  // Load about content
  await progress.run('Loading about content...', 0.95, async () => {
    await aboutService.init();
  });

  // Finalize renderer
  renderer.finalize();

  return paletteService;
}
