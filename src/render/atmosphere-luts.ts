/**
 * Atmosphere LUT loader
 * Loads precomputed Bruneton atmospheric scattering lookup tables
 */

export interface AtmosphereLUTs {
  transmittance: GPUTexture;
  scattering: GPUTexture;
  irradiance: GPUTexture;
  sampler: GPUSampler;
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

async function loadBinaryData(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.arrayBuffer();
}

export async function loadAtmosphereLUTs(device: GPUDevice): Promise<AtmosphereLUTs> {
  console.log('[Atmosphere] Loading LUTs...');

  // Load all data files in parallel
  const [transmittanceData, scatteringData, irradianceData] = await Promise.all([
    loadBinaryData('/atmosphere/transmittance.dat'),
    loadBinaryData('/atmosphere/scattering.dat'),
    loadBinaryData('/atmosphere/irradiance.dat'),
  ]);

  console.log(`[Atmosphere] Loaded: transmittance=${transmittanceData.byteLength}, scattering=${scatteringData.byteLength}, irradiance=${irradianceData.byteLength}`);

  // Create transmittance texture (2D, 256x64, rgba32float)
  const transmittance = device.createTexture({
    size: [TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: transmittance },
    transmittanceData,
    { bytesPerRow: TRANSMITTANCE_WIDTH * 16 },
    { width: TRANSMITTANCE_WIDTH, height: TRANSMITTANCE_HEIGHT }
  );

  // Create scattering texture (3D, packed: width=NU*MU_S, height=MU, depth=R)
  // 4D (r, mu, mu_s, nu) packed as 3D: x = nu*MU_S + mu_s, y = mu, z = r
  const scatteringWidth = SCATTERING_NU * SCATTERING_MU_S;  // 8 * 32 = 256
  const scatteringHeight = SCATTERING_MU;  // 128
  const scatteringDepth = SCATTERING_R;  // 32

  const scattering = device.createTexture({
    size: [scatteringWidth, scatteringHeight, scatteringDepth],
    format: 'rgba32float',
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: scattering },
    scatteringData,
    { bytesPerRow: scatteringWidth * 16, rowsPerImage: scatteringHeight },
    { width: scatteringWidth, height: scatteringHeight, depthOrArrayLayers: scatteringDepth }
  );

  // Create irradiance texture (2D, 64x16, rgba32float)
  const irradiance = device.createTexture({
    size: [IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: irradiance },
    irradianceData,
    { bytesPerRow: IRRADIANCE_WIDTH * 16 },
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

  console.log('[Atmosphere] LUTs loaded successfully');

  return { transmittance, scattering, irradiance, sampler };
}
