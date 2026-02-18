/**
 * Parameter Metadata - Data ranges and palette hints for ECMWF IFS parameters
 *
 * Ranges are educated guesses based on typical Earth values.
 * Run scripts/analyze-param-ranges.py on actual data to verify.
 * 
 * https://openmeteo.s3.amazonaws.com/index.html
 * https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/latest.json
 */

export interface ParamMeta {
  label: string;
  unit: string;
  range: [number, number];  // [min, max] for palette mapping
  palette: string;          // suggested palette name
  sizeEstimate: number;     // compressed bytes per timestep (0 = unknown, learned at runtime)
  description?: string;
  published?: boolean;      // tested and available for custom layers
  layers?: string[];        // built-in layers using this param (e.g., ['temp'], ['wind'])
  categorical?: boolean;    // true = nearest-neighbor temporal sampling (no interpolation)
}

export const PARAM_METADATA: Record<string, ParamMeta> = {
  // ============================================================
  // Temperature (stored in Kelvin, display in Celsius)
  // ============================================================
  'temperature_2m': {
    label: 'Temperature (2m)',
    unit: '°C',
    range: [-40, 50],  // Data stored in Celsius
    palette: 'thermal',
    sizeEstimate: 8_000_000,
    published: true,
    layers: ['temp'],
  },
  'temperature_2m_max': {
    label: 'Max Temperature (2m)',
    unit: 'K',
    range: [233, 333],  // -40°C to 60°C
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'temperature_2m_min': {
    label: 'Min Temperature (2m)',
    unit: 'K',
    range: [213, 313],  // -60°C to 40°C
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'surface_temperature': {
    label: 'Surface Temperature',
    unit: 'K',
    range: [213, 343],  // -60°C to 70°C (deserts get hot)
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'dew_point_2m': {
    label: 'Dew Point (2m)',
    unit: 'K',
    range: [233, 303],  // -40°C to 30°C
    palette: 'thermal',
    sizeEstimate: 0,
  },

  // ============================================================
  // Soil Temperature (Kelvin)
  // ============================================================
  'soil_temperature_0_to_7cm': {
    label: 'Soil Temp (0-7cm)',
    unit: 'K',
    range: [253, 323],  // -20°C to 50°C
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'soil_temperature_7_to_28cm': {
    label: 'Soil Temp (7-28cm)',
    unit: 'K',
    range: [263, 308],  // -10°C to 35°C (more stable)
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'soil_temperature_28_to_100cm': {
    label: 'Soil Temp (28-100cm)',
    unit: 'K',
    range: [273, 303],  // 0°C to 30°C (even more stable)
    palette: 'thermal',
    sizeEstimate: 0,
  },
  'soil_temperature_100_to_255cm': {
    label: 'Soil Temp (100-255cm)',
    unit: 'K',
    range: [278, 298],  // 5°C to 25°C (very stable)
    palette: 'thermal',
    sizeEstimate: 0,
  },

  // ============================================================
  // Moisture & Precipitation
  // ============================================================
  'precipitation': {
    label: 'Precipitation',
    unit: 'mm',
    range: [0, 50],  // 0-50mm/hr (heavy rain)
    palette: 'rain',
    sizeEstimate: 8_000_000,
  },
  'showers': {
    label: 'Showers',
    unit: 'mm',
    range: [0, 30],
    palette: 'rain',
    sizeEstimate: 0,
  },
  'snowfall_water_equivalent': {
    label: 'Snowfall',
    unit: 'mm',
    range: [0, 30],
    palette: 'snow',
    sizeEstimate: 0,
  },
  'snow_depth': {
    label: 'Snow Depth',
    unit: 'm',
    range: [0, 5],  // 0-5m
    palette: 'snow',
    sizeEstimate: 0,
  },
  'snow_density': {
    label: 'Snow Density',
    unit: 'kg/m³',
    range: [50, 500],  // fresh snow to packed
    palette: 'density',
    sizeEstimate: 0,
  },
  'runoff': {
    label: 'Runoff',
    unit: 'mm',
    range: [0, 50],
    palette: 'water',
    sizeEstimate: 0,
  },
  'potential_evapotranspiration': {
    label: 'Evapotranspiration',
    unit: 'mm',
    range: [0, 15],
    palette: 'water',
    sizeEstimate: 0,
  },

  // ============================================================
  // Soil Moisture (volumetric, m³/m³)
  // ============================================================
  'soil_moisture_0_to_7cm': {
    label: 'Soil Moisture (0-7cm)',
    unit: 'm³/m³',
    range: [0, 0.6],
    palette: 'moisture',
    sizeEstimate: 0,
  },
  'soil_moisture_7_to_28cm': {
    label: 'Soil Moisture (7-28cm)',
    unit: 'm³/m³',
    range: [0, 0.5],
    palette: 'moisture',
    sizeEstimate: 0,
  },
  'soil_moisture_28_to_100cm': {
    label: 'Soil Moisture (28-100cm)',
    unit: 'm³/m³',
    range: [0, 0.45],
    palette: 'moisture',
    sizeEstimate: 0,
  },
  'soil_moisture_100_to_255cm': {
    label: 'Soil Moisture (100-255cm)',
    unit: 'm³/m³',
    range: [0, 0.4],
    palette: 'moisture',
    sizeEstimate: 0,
  },

  // ============================================================
  // Cloud Cover (percentage)
  // ============================================================
  'cloud_cover': {
    label: 'Cloud Cover',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
    sizeEstimate: 8_000_000,
    published: true,
    layers: ['clouds'],
  },
  'cloud_cover_low': {
    label: 'Low Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
    sizeEstimate: 0,
  },
  'cloud_cover_mid': {
    label: 'Mid Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
    sizeEstimate: 0,
  },
  'cloud_cover_high': {
    label: 'High Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
    sizeEstimate: 0,
  },
  'total_column_integrated_water_vapour': {
    label: 'Water Vapour Column',
    unit: 'kg/m²',
    range: [0, 70],  // tropical max ~70
    palette: 'moisture',
    sizeEstimate: 0,
  },

  // ============================================================
  // Wind (m/s)
  // ============================================================
  'wind_u_component_10m': {
    label: 'Wind U (10m)',
    unit: 'm/s',
    range: [-50, 50],
    palette: 'diverging',
    sizeEstimate: 4_100_000,  // ~half of 8.2MB combined
    published: true,
    layers: ['wind'],
  },
  'wind_v_component_10m': {
    label: 'Wind V (10m)',
    unit: 'm/s',
    range: [-50, 50],
    palette: 'diverging',
    sizeEstimate: 4_100_000,
    published: true,
    layers: ['wind'],
  },
  'wind_u_component_100m': {
    label: 'Wind U (100m)',
    unit: 'm/s',
    range: [-60, 60],
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'wind_v_component_100m': {
    label: 'Wind V (100m)',
    unit: 'm/s',
    range: [-60, 60],
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'wind_u_component_200m': {
    label: 'Wind U (200m)',
    unit: 'm/s',
    range: [-70, 70],
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'wind_v_component_200m': {
    label: 'Wind V (200m)',
    unit: 'm/s',
    range: [-70, 70],
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'wind_gusts_10m': {
    label: 'Wind Gusts (10m)',
    unit: 'm/s',
    range: [0, 80],  // hurricane-force gusts
    palette: 'wind',
    sizeEstimate: 0,
  },

  // ============================================================
  // Pressure (Pa, display as hPa)
  // ============================================================
  'pressure_msl': {
    label: 'Pressure (MSL)',
    unit: 'Pa',
    range: [97000, 105000],  // 970-1050 hPa
    palette: 'pressure',
    sizeEstimate: 2_000_000,
    published: true,
    layers: ['pressure'],
  },

  // ============================================================
  // Radiation (W/m²)
  // ============================================================
  'shortwave_radiation': {
    label: 'Solar Radiation',
    unit: 'W/m²',
    range: [0, 1200],  // max solar constant at surface
    palette: 'solar',
    sizeEstimate: 0,
  },
  'direct_radiation': {
    label: 'Direct Radiation',
    unit: 'W/m²',
    range: [0, 1000],
    palette: 'solar',
    sizeEstimate: 0,
  },

  // ============================================================
  // Convective / Stability
  // ============================================================
  'cape': {
    label: 'CAPE',
    unit: 'J/kg',
    range: [0, 5000],  // >2500 = severe storms
    palette: 'convective',
    sizeEstimate: 0,
    description: 'Convective Available Potential Energy',
  },
  'convective_inhibition': {
    label: 'CIN',
    unit: 'J/kg',
    range: [-500, 0],  // negative values
    palette: 'convective',
    sizeEstimate: 0,
  },
  'k_index': {
    label: 'K-Index',
    unit: 'K',
    range: [0, 40],  // >30 = high thunderstorm potential
    palette: 'convective',
    sizeEstimate: 0,
  },
  'lightning_density': {
    label: 'Lightning',
    unit: 'fl/km²',
    range: [0, 10],
    palette: 'lightning',
    sizeEstimate: 0,
  },

  // ============================================================
  // Surface Properties
  // ============================================================
  'albedo': {
    label: 'Albedo',
    unit: '',
    range: [0, 1],  // 0=black, 1=white
    palette: 'grayscale',
    sizeEstimate: 0,
    description: 'Surface reflectivity',
  },
  'roughness_length': {
    label: 'Roughness',
    unit: 'm',
    range: [0, 2],  // ocean=0.001, forest=1-2
    palette: 'terrain',
    sizeEstimate: 0,
  },
  'boundary_layer_height': {
    label: 'Boundary Layer',
    unit: 'm',
    range: [0, 4000],  // daytime convective max
    palette: 'height',
    sizeEstimate: 0,
  },
  'visibility': {
    label: 'Visibility',
    unit: 'm',
    range: [0, 50000],  // 0=fog, 50km=clear
    palette: 'visibility',
    sizeEstimate: 0,
  },

  // ============================================================
  // Ocean
  // ============================================================
  'ocean_u_current': {
    label: 'Ocean Current U',
    unit: 'm/s',
    range: [-3, 3],  // Gulf Stream ~2 m/s
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'ocean_v_current': {
    label: 'Ocean Current V',
    unit: 'm/s',
    range: [-3, 3],
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'sea_level_height_msl': {
    label: 'Sea Level Height',
    unit: 'm',
    range: [-2, 2],  // dynamic topography
    palette: 'diverging',
    sizeEstimate: 0,
  },
  'sea_ice_thickness': {
    label: 'Sea Ice Thickness',
    unit: 'm',
    range: [0, 5],
    palette: 'ice',
    sizeEstimate: 0,
  },

  // ============================================================
  // Misc
  // ============================================================
  'precipitation_type': {
    label: 'Precip Type',
    unit: 'WMO code',
    range: [0, 12],  // WMO: 0=none, 1=rain, 3=freezing rain, 5=snow, 6-7=mix, 8=ice pellets, 12=freezing drizzle
    palette: 'categorical',
    sizeEstimate: 800_000,
    published: true,
    layers: ['rain'],
    categorical: true,
  },
};

/**
 * Get metadata for a parameter
 */
export function getParamMeta(param: string): ParamMeta {
  const meta = PARAM_METADATA[param];
  if (!meta) {
    throw new Error(`Unknown param: ${param}`);
  }
  return meta;
}

/**
 * Get all known parameter IDs
 */
export function getKnownParams(): string[] {
  return Object.keys(PARAM_METADATA);
}

/**
 * Get published params — tested and available for custom layers
 */
export function getPublishedParams(): string[] {
  return Object.entries(PARAM_METADATA)
    .filter(([, meta]) => meta.published)
    .map(([param]) => param);
}

