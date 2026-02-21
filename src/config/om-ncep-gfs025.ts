/**
 * NCEP GFS 0.25° Model Definition
 *
 * Regular lat/lon grid (721 × 1440 = 1,038,240 points).
 * Used for advection wind — low-res vectors to displace precipitation/cloud fields.
 * https://openmeteo.s3.amazonaws.com/data_spatial/ncep_gfs025/latest.json
 */

import type { ParamMeta } from './om-ecmwf-ifs';
import type { PaletteId } from '../services/palette-service';

export const NCEP_GFS025 = {
  name: 'ncep_gfs025',
  root: 'https://openmeteo.s3.amazonaws.com/data_spatial/ncep_gfs025',
  bufferMB: 4,              // 721 × 1440 × 4 bytes ≈ 4 MB
  gridPoints: 1_038_240,
  params: {
    wind_u_component_1000hPa: {
      label: 'Wind U (1000hPa)', unit: 'm/s', range: [-50, 50] as [number, number],
      palette: 'wind-magnitude' as PaletteId, sizeEstimate: 3_000_000,
      description: 'Eastward wind at 1000 hPa (advection)',
      published: false, layers: ['rain'],
    },
    wind_v_component_1000hPa: {
      label: 'Wind V (1000hPa)', unit: 'm/s', range: [-50, 50] as [number, number],
      palette: 'wind-magnitude' as PaletteId, sizeEstimate: 3_000_000,
      description: 'Northward wind at 1000 hPa (advection)',
      published: false, layers: ['rain'],
    },
  },
} as const satisfies { name: string; root: string; bufferMB: number; gridPoints: number; params: Record<string, ParamMeta> };

export type TNcepGfs025Param = keyof typeof NCEP_GFS025.params;
