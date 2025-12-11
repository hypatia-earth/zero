/**
 * DataLoader - Sequential asset loading during bootstrap DATA step
 *
 * Loads all assets in sequence, updating BootstrapService with progress.
 * All fetches go through FetchService for bandwidth tracking.
 */

import { BootstrapService } from './bootstrap-service';
import type { FetchService } from './fetch-service';

// Progress range for DATA step (20-95%)
const DATA_START = 20;
const DATA_END = 95;
const TOTAL_ITEMS = 14;  // 1 WASM + 3 LUTs + 6 basemap + 2 temp + 2 precip

export class DataLoader {
  private itemsLoaded = 0;

  constructor(private fetchService: FetchService) {}

  private progress(): number {
    return DATA_START + (this.itemsLoaded / TOTAL_ITEMS) * (DATA_END - DATA_START);
  }

  async loadWasm(): Promise<ArrayBuffer> {
    await BootstrapService.updateProgress('Loading WASM decoder...', this.progress());
    const buffer = await this.fetchService.fetch('/om-decoder.wasm');
    this.itemsLoaded++;
    return buffer;
  }

  async loadAtmosphereLUTs(useFloat16: boolean): Promise<{
    transmittance: ArrayBuffer;
    scattering: ArrayBuffer;
    irradiance: ArrayBuffer;
  }> {
    const suffix = useFloat16 ? '-16' : '';

    await BootstrapService.updateProgress('Loading atmosphere 1/3...', this.progress());
    const transmittance = await this.fetchService.fetch(`/atmosphere/transmittance${suffix}.dat`);
    this.itemsLoaded++;

    await BootstrapService.updateProgress('Loading atmosphere 2/3...', this.progress());
    const scattering = await this.fetchService.fetch(`/atmosphere/scattering${suffix}.dat`);
    this.itemsLoaded++;

    await BootstrapService.updateProgress('Loading atmosphere 3/3...', this.progress());
    const irradiance = await this.fetchService.fetch(`/atmosphere/irradiance${suffix}.dat`);
    this.itemsLoaded++;

    return { transmittance, scattering, irradiance };
  }

  async loadBasemap(): Promise<ImageBitmap[]> {
    const faceNames = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const faces: ImageBitmap[] = [];

    for (let i = 0; i < faceNames.length; i++) {
      const name = faceNames[i];
      await BootstrapService.updateProgress(`Loading basemap ${i + 1}/6...`, this.progress());

      try {
        const buffer = await this.fetchService.fetch(`/images/basemaps/rtopo2/${name}.png`);
        const blob = new Blob([buffer], { type: 'image/png' });
        faces.push(await createImageBitmap(blob));
      } catch {
        console.warn(`[DataLoader] Basemap face ${name} not found, using placeholder`);
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 256, 256);
        faces.push(await createImageBitmap(canvas));
      }

      this.itemsLoaded++;
    }

    return faces;
  }

  async loadTemperatureTimesteps(
    loadTimestep: (index: number, total: number) => Promise<void>
  ): Promise<void> {
    await BootstrapService.updateProgress('Loading temperature 1/2...', this.progress());
    await loadTimestep(0, 2);
    this.itemsLoaded++;

    await BootstrapService.updateProgress('Loading temperature 2/2...', this.progress());
    await loadTimestep(1, 2);
    this.itemsLoaded++;
  }

  async loadPrecipitationTimesteps(): Promise<void> {
    await BootstrapService.updateProgress('Loading precipitation 1/2...', this.progress());
    // Placeholder - no actual load yet
    this.itemsLoaded++;

    await BootstrapService.updateProgress('Loading precipitation 2/2...', this.progress());
    this.itemsLoaded++;
  }
}
