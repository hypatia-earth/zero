/**
 * ECMWF IFS Model Definition
 *
 * O1280 octahedral reduced Gaussian grid (6,599,680 points).
 * https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/latest.json
 */

import type { PaletteId } from '../services/palette-service';

export interface ParamMeta {
  label: string;
  unit: string;
  range: [number, number];
  palette: PaletteId;
  sizeEstimate: number;     // compressed bytes per timestep (0 = unknown)
  description?: string;
  published?: boolean;      // available for custom layers
  layers?: string[];        // built-in layers using this param
  categorical?: boolean;    // nearest-neighbor temporal sampling
  backwardSum?: boolean;    // backward accumulation sum, undefined at T+0
}

export const ECMWF_IFS = {
  name: 'ecmwf_ifs',
  shortName: 'IFS',
  root: 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs',
  bufferMB: 26,             // O1280: 6,599,680 × 4 bytes ≈ 26 MB
  gridPoints: 6_599_680,
  params: {
    temperature_2m: {
      label: 'Temperature (2m)', unit: '°C', range: [-40, 50] as [number, number],
      palette: 'simple-gradient' as PaletteId, sizeEstimate: 3_600_000,
      description: 'Air temperature at 2 meters above ground',
      published: true, layers: ['temp'],
    },
    precipitation: {
      label: 'Precipitation', unit: 'mm', range: [0, 50] as [number, number],
      palette: 'rain-wet-intensity' as PaletteId, sizeEstimate: 8_000_000,
      description: 'Total precipitation (backward accumulation)',
      published: true, layers: ['rain'], backwardSum: true,
    },
    snowfall_water_equivalent: {
      label: 'Snowfall', unit: 'mm', range: [0, 50] as [number, number],
      palette: 'rain-frozen-intensity' as PaletteId, sizeEstimate: 200_000,
      description: 'Snowfall water equivalent (backward accumulation)',
      published: true, layers: ['rain'], backwardSum: true,
    },
    cloud_cover: {
      label: 'Cloud Cover', unit: '%', range: [0, 100] as [number, number],
      palette: 'cloud-cover' as PaletteId, sizeEstimate: 3_500_000,
      description: 'Total cloud cover fraction',
      published: true, layers: ['clouds'],
    },
    wind_u_component_10m: {
      label: 'Wind U (10m)', unit: 'm/s', range: [-50, 50] as [number, number],
      palette: 'wind-magnitude' as PaletteId, sizeEstimate: 4_100_000,
      description: 'Eastward wind component at 10m',
      published: true, layers: ['wind'],
    },
    wind_v_component_10m: {
      label: 'Wind V (10m)', unit: 'm/s', range: [-50, 50] as [number, number],
      palette: 'wind-magnitude' as PaletteId, sizeEstimate: 4_100_000,
      description: 'Northward wind component at 10m',
      published: true, layers: ['wind'],
    },
    pressure_msl: {
      label: 'Pressure (MSL)', unit: 'Pa', range: [97000, 105000] as [number, number],
      palette: 'pressure-gradient' as PaletteId, sizeEstimate: 2_100_000,
      description: 'Mean sea level pressure',
      published: true, layers: ['pressure'],
    },
    sea_ice_concentration: {
      label: 'Sea Ice', unit: '%', range: [0, 100] as [number, number],
      palette: 'simple-gradient' as PaletteId, sizeEstimate: 500_000,
      description: 'Sea ice area fraction (stub — texture param validation)',
      layers: ['sea-ice'],
    },
    sea_surface_temperature: {
      label: 'Ocean Temp', unit: '°C', range: [-2, 35] as [number, number],
      palette: 'simple-gradient' as PaletteId, sizeEstimate: 3_500_000,
      description: 'Sea surface temperature (stub — texture param validation)',
      layers: ['ocean-temp'],
    },
    dewpoint_2m: {
      label: 'Dewpoint (2m)', unit: '°C', range: [-40, 35] as [number, number],
      palette: 'simple-gradient' as PaletteId, sizeEstimate: 3_500_000,
      description: 'Dewpoint temperature at 2m (stub — texture param validation)',
      layers: ['wet-bulb'],
    },
  },
} as const satisfies { name: string; shortName: string; root: string; bufferMB: number; gridPoints: number; params: Record<string, ParamMeta> };

export type TEcmwfIfsParam = keyof typeof ECMWF_IFS.params;
