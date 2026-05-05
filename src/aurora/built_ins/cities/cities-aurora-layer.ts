/**
 * CitiesAuroraLayer — built-in AuroraLayer for city labels (MSDF text on globe).
 *
 * Wraps CitiesLayer (CPU placement) + CitiesAnimator (LoD state machine). Render
 * path is composed via main.wesl's blendCities; this plugin only contributes
 * initialize + update. GPU resources (lookup texture, font atlas, sampler) live
 * in the host's bind group; the layer drives writes through a small host handle.
 *
 * Phase 3 of aurora-autarky Sub-A.
 */

import { CitiesLayer, LOOKUP_WIDTH, LOOKUP_HEIGHT } from './cities-layer';
import { CitiesAnimator } from './cities-animator';
import { U } from '../../globe-uniforms';
import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from '../../types/aurora-layer';

export interface CitiesLodLevel {
  minPopulation: number;   // minimum population to show at this LoD
  zoomInPx: number;        // enter this LoD when globeRadiusPx >= this
  zoomOutPx: number;       // leave this LoD when globeRadiusPx <= this
}

export const CITIES_DEFAULT_LOD_LEVELS: CitiesLodLevel[] = [
  { minPopulation: 5_000_000, zoomInPx: 0,   zoomOutPx: 0 },
  { minPopulation: 1_000_000, zoomInPx: 200, zoomOutPx: 170 },
  { minPopulation: 300_000,   zoomInPx: 400, zoomOutPx: 350 },
  { minPopulation: 100_000,   zoomInPx: 600, zoomOutPx: 550 },
];

/**
 * Host-provided GPU surface for cities. The host owns the lookup texture and the
 * (potentially resizable) data buffer because both participate in the host bind
 * group. The layer mutates them through this handle and signals bind group rebuild.
 */
export interface CitiesAuroraLayerHost {
  readonly cityLookupTexture: GPUTexture;
  /** Current data buffer; layer reads it, swaps via setCityDataBuffer on resize. */
  readonly cityDataBuffer: GPUBuffer;
  setCityDataBuffer(buf: GPUBuffer): void;
  /** Host's CPU staging view for the uniform buffer (cityGlyphOffset write target). */
  uniformView: DataView;
  recreateBindGroup(): void;
}

const ALT_THRESHOLD_KM = 3000;
const EARTH_RADIUS_KM = 6371;

export class CitiesAuroraLayer implements AuroraLayer {
  readonly id = 'cities';
  readonly order = 25;

  private device!: GPUDevice;
  private innerLayer!: CitiesLayer;
  private animator!: CitiesAnimator;

  constructor(
    private readonly initialGlobeRadiusPx: number,
    private readonly citiesDataBuffer: ArrayBuffer,
    private readonly metricsBuffer: ArrayBuffer,
    private readonly host: CitiesAuroraLayerHost,
  ) {}

  initialize(ctx: AuroraLayerContext): void {
    this.device = ctx.device;
    this.innerLayer = new CitiesLayer(this.citiesDataBuffer, this.metricsBuffer, CITIES_DEFAULT_LOD_LEVELS);
    this.animator = new CitiesAnimator(this.innerLayer, this.initialGlobeRadiusPx, CITIES_DEFAULT_LOD_LEVELS);
    this.uploadTier();
  }

  onDataChanged(_ctx: AuroraLayerContext, _events: AuroraDataEvent[]): void {
    // Cities data is passed once at construction; no streaming inputs
  }

  onOptionsChanged(_ctx: AuroraLayerContext, _options: Record<string, unknown>): void {
    // cities.opacity flows through host layer-opacities path; nothing layer-local yet
  }

  compute(_frame: AuroraLayerFrame): boolean {
    return false;
  }

  update(frame: AuroraLayerFrame): void {
    // Altitude gate — at high altitude we render indicators only and freeze the LoD tier.
    // The cityFontScale uniform doubles as a shader-side gate (0 = indicators only, 1.3 = labels).
    const cameraDistance = Math.hypot(
      frame.eyePosition[0]!,
      frame.eyePosition[1]!,
      frame.eyePosition[2]!,
    );
    const altitudeKm = (cameraDistance - 1) * EARTH_RADIUS_KM;
    const cityFontScale = altitudeKm > ALT_THRESHOLD_KM ? 0 : 1.3;
    this.host.uniformView.setFloat32(U.cityFontScale, cityFontScale, true);

    if (cityFontScale === 0) return;

    if (this.animator.update(frame.globeRadiusPx, frame.frameDeltaMs)) {
      this.uploadTier();
    }
  }

  render(_frame: AuroraLayerFrame, _pass: GPURenderPassEncoder): void {
    // Composed via blendCities in main.wesl; no separate render pass
  }

  dispose(): void {
    // CitiesLayer + CitiesAnimator are pure TS; nothing to release
  }

  private uploadTier(): void {
    const tier = this.innerLayer.currentTierIndex;
    const data = this.innerLayer.buildTier(tier);

    this.device.queue.writeTexture(
      { texture: this.host.cityLookupTexture },
      data.lookupData.buffer as ArrayBuffer,
      { bytesPerRow: LOOKUP_WIDTH * 2 },
      { width: LOOKUP_WIDTH, height: LOOKUP_HEIGHT },
    );

    if (data.combinedBuffer.byteLength > this.host.cityDataBuffer.size) {
      this.host.cityDataBuffer.destroy();
      this.host.setCityDataBuffer(this.device.createBuffer({
        size: Math.max(32, data.combinedBuffer.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
    }
    if (data.combinedBuffer.byteLength > 0) {
      this.device.queue.writeBuffer(this.host.cityDataBuffer, 0, data.combinedBuffer);
    }

    this.host.uniformView.setUint32(U.cityGlyphOffset, data.glyphStartVec4, true);

    this.host.recreateBindGroup();
  }
}
