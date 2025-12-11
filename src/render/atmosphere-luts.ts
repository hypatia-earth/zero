/**
 * Atmosphere LUT texture creation
 * Creates GPU textures from preloaded Bruneton atmospheric scattering LUT data
 *
 * Uses rgba32float on devices supporting float32-filterable,
 * falls back to rgba16float on others (e.g., iPad Safari).
 *
 * Note: Data loading moved to DataLoader for centralized fetch tracking
 */

export interface AtmosphereLUTs {
  transmittance: GPUTexture;
  scattering: GPUTexture;
  irradiance: GPUTexture;
  sampler: GPUSampler;
}

export interface AtmosphereLUTData {
  transmittance: ArrayBuffer;
  scattering: ArrayBuffer;
  irradiance: ArrayBuffer;
}

// LUT dimensions (must match precomputed data and shader constants)
const TRANSMITTANCE_WIDTH = 256;
const TRANSMITTANCE_HEIGHT = 64;
const SCATTERING_R = 32;
const SCATTERING_MU = 128;
const SCATTERING_MU_S = 32;
const SCATTERING_NU = 8;
const IRRADIANCE_WIDTH = 64;
const IRRADIANCE_HEIGHT = 16;

/**
 * Create atmosphere LUT textures from pre-loaded data
 */
export function createAtmosphereLUTs(
  device: GPUDevice,
  data: AtmosphereLUTData,
  useFloat16: boolean
): AtmosphereLUTs {
  const format: GPUTextureFormat = useFloat16 ? 'rgba16float' : 'rgba32float';
  const bytesPerPixel = useFloat16 ? 8 : 16;  // 4 channels × 2 or 4 bytes

  // Create transmittance texture (2D, 256x64)
  const transmittance = device.createTexture({
    size: [TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: transmittance },
    data.transmittance,
    { bytesPerRow: TRANSMITTANCE_WIDTH * bytesPerPixel },
    { width: TRANSMITTANCE_WIDTH, height: TRANSMITTANCE_HEIGHT }
  );

  // Create scattering texture (3D, packed: width=NU*MU_S, height=MU, depth=R)
  const scatteringWidth = SCATTERING_NU * SCATTERING_MU_S;  // 8 * 32 = 256
  const scatteringHeight = SCATTERING_MU;  // 128
  const scatteringDepth = SCATTERING_R;  // 32

  const scattering = device.createTexture({
    size: [scatteringWidth, scatteringHeight, scatteringDepth],
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: scattering },
    data.scattering,
    { bytesPerRow: scatteringWidth * bytesPerPixel, rowsPerImage: scatteringHeight },
    { width: scatteringWidth, height: scatteringHeight, depthOrArrayLayers: scatteringDepth }
  );

  // Create irradiance texture (2D, 64x16)
  const irradiance = device.createTexture({
    size: [IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: irradiance },
    data.irradiance,
    { bytesPerRow: IRRADIANCE_WIDTH * bytesPerPixel },
    { width: IRRADIANCE_WIDTH, height: IRRADIANCE_HEIGHT }
  );

  // Create linear sampler for LUT interpolation
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });

  console.log(`[Atmosphere] LUTs created (${useFloat16 ? 'float16' : 'float32'})`);

  return { transmittance, scattering, irradiance, sampler };
}
