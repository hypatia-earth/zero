/**
 * Parameter Metadata for NCEP GFS 0.25° model
 *
 * Used for advection wind — low-res wind vectors to displace
 * precipitation and cloud fields between timesteps.
 *
 * https://openmeteo.s3.amazonaws.com/data_spatial/ncep_gfs025/latest.json
 */

import { type ParamMeta, registerParamRegistry } from './params-ecmwf_ifs';

export const PARAM_METADATA_GFS: Record<string, ParamMeta> = {
  'wind_u_component_1000hPa': {
    label: 'Wind U (1000hPa)',
    unit: 'm/s',
    range: [-50, 50],
    palette: 'wind-magnitude',
    sizeEstimate: 3_000_000,
    layers: ['rain'],
  },
  'wind_v_component_1000hPa': {
    label: 'Wind V (1000hPa)',
    unit: 'm/s',
    range: [-50, 50],
    palette: 'wind-magnitude',
    sizeEstimate: 3_000_000,
    layers: ['rain'],
  },
};

// Self-register so getParamMeta() finds GFS params
registerParamRegistry(PARAM_METADATA_GFS);
