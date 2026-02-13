/**
 * Parameter Metadata - Data ranges and palette hints for ECMWF IFS parameters
 *
 * Ranges are educated guesses based on typical Earth values.
 * Run scripts/analyze-param-ranges.py on actual data to verify.
 */

export interface ParamMeta {
  label: string;
  unit: string;
  range: [number, number];  // [min, max] for palette mapping
  palette: string;          // suggested palette name
  description?: string;
  sizeEstimate?: number;    // compressed bytes per timestep (for queue ETA)
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
  },
  'temperature_2m_max': {
    label: 'Max Temperature (2m)',
    unit: 'K',
    range: [233, 333],  // -40°C to 60°C
    palette: 'thermal',
  },
  'temperature_2m_min': {
    label: 'Min Temperature (2m)',
    unit: 'K',
    range: [213, 313],  // -60°C to 40°C
    palette: 'thermal',
  },
  'surface_temperature': {
    label: 'Surface Temperature',
    unit: 'K',
    range: [213, 343],  // -60°C to 70°C (deserts get hot)
    palette: 'thermal',
  },
  'dew_point_2m': {
    label: 'Dew Point (2m)',
    unit: 'K',
    range: [233, 303],  // -40°C to 30°C
    palette: 'thermal',
  },

  // ============================================================
  // Soil Temperature (Kelvin)
  // ============================================================
  'soil_temperature_0_to_7cm': {
    label: 'Soil Temp (0-7cm)',
    unit: 'K',
    range: [253, 323],  // -20°C to 50°C
    palette: 'thermal',
  },
  'soil_temperature_7_to_28cm': {
    label: 'Soil Temp (7-28cm)',
    unit: 'K',
    range: [263, 308],  // -10°C to 35°C (more stable)
    palette: 'thermal',
  },
  'soil_temperature_28_to_100cm': {
    label: 'Soil Temp (28-100cm)',
    unit: 'K',
    range: [273, 303],  // 0°C to 30°C (even more stable)
    palette: 'thermal',
  },
  'soil_temperature_100_to_255cm': {
    label: 'Soil Temp (100-255cm)',
    unit: 'K',
    range: [278, 298],  // 5°C to 25°C (very stable)
    palette: 'thermal',
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
  },
  'snowfall_water_equivalent': {
    label: 'Snowfall',
    unit: 'mm',
    range: [0, 30],
    palette: 'snow',
  },
  'snow_depth': {
    label: 'Snow Depth',
    unit: 'm',
    range: [0, 5],  // 0-5m
    palette: 'snow',
  },
  'snow_density': {
    label: 'Snow Density',
    unit: 'kg/m³',
    range: [50, 500],  // fresh snow to packed
    palette: 'density',
  },
  'runoff': {
    label: 'Runoff',
    unit: 'mm',
    range: [0, 50],
    palette: 'water',
  },
  'potential_evapotranspiration': {
    label: 'Evapotranspiration',
    unit: 'mm',
    range: [0, 15],
    palette: 'water',
  },

  // ============================================================
  // Soil Moisture (volumetric, m³/m³)
  // ============================================================
  'soil_moisture_0_to_7cm': {
    label: 'Soil Moisture (0-7cm)',
    unit: 'm³/m³',
    range: [0, 0.6],
    palette: 'moisture',
  },
  'soil_moisture_7_to_28cm': {
    label: 'Soil Moisture (7-28cm)',
    unit: 'm³/m³',
    range: [0, 0.5],
    palette: 'moisture',
  },
  'soil_moisture_28_to_100cm': {
    label: 'Soil Moisture (28-100cm)',
    unit: 'm³/m³',
    range: [0, 0.45],
    palette: 'moisture',
  },
  'soil_moisture_100_to_255cm': {
    label: 'Soil Moisture (100-255cm)',
    unit: 'm³/m³',
    range: [0, 0.4],
    palette: 'moisture',
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
  },
  'cloud_cover_low': {
    label: 'Low Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
  },
  'cloud_cover_mid': {
    label: 'Mid Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
  },
  'cloud_cover_high': {
    label: 'High Clouds',
    unit: '%',
    range: [0, 100],
    palette: 'clouds',
  },
  'total_column_integrated_water_vapour': {
    label: 'Water Vapour Column',
    unit: 'kg/m²',
    range: [0, 70],  // tropical max ~70
    palette: 'moisture',
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
  },
  'wind_v_component_10m': {
    label: 'Wind V (10m)',
    unit: 'm/s',
    range: [-50, 50],
    palette: 'diverging',
    sizeEstimate: 4_100_000,
  },
  'wind_u_component_100m': {
    label: 'Wind U (100m)',
    unit: 'm/s',
    range: [-60, 60],
    palette: 'diverging',
  },
  'wind_v_component_100m': {
    label: 'Wind V (100m)',
    unit: 'm/s',
    range: [-60, 60],
    palette: 'diverging',
  },
  'wind_u_component_200m': {
    label: 'Wind U (200m)',
    unit: 'm/s',
    range: [-70, 70],
    palette: 'diverging',
  },
  'wind_v_component_200m': {
    label: 'Wind V (200m)',
    unit: 'm/s',
    range: [-70, 70],
    palette: 'diverging',
  },
  'wind_gusts_10m': {
    label: 'Wind Gusts (10m)',
    unit: 'm/s',
    range: [0, 80],  // hurricane-force gusts
    palette: 'wind',
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
  },

  // ============================================================
  // Radiation (W/m²)
  // ============================================================
  'shortwave_radiation': {
    label: 'Solar Radiation',
    unit: 'W/m²',
    range: [0, 1200],  // max solar constant at surface
    palette: 'solar',
  },
  'direct_radiation': {
    label: 'Direct Radiation',
    unit: 'W/m²',
    range: [0, 1000],
    palette: 'solar',
  },

  // ============================================================
  // Convective / Stability
  // ============================================================
  'cape': {
    label: 'CAPE',
    unit: 'J/kg',
    range: [0, 5000],  // >2500 = severe storms
    palette: 'convective',
    description: 'Convective Available Potential Energy',
  },
  'convective_inhibition': {
    label: 'CIN',
    unit: 'J/kg',
    range: [-500, 0],  // negative values
    palette: 'convective',
  },
  'k_index': {
    label: 'K-Index',
    unit: 'K',
    range: [0, 40],  // >30 = high thunderstorm potential
    palette: 'convective',
  },
  'lightning_density': {
    label: 'Lightning',
    unit: 'fl/km²',
    range: [0, 10],
    palette: 'lightning',
  },

  // ============================================================
  // Surface Properties
  // ============================================================
  'albedo': {
    label: 'Albedo',
    unit: '',
    range: [0, 1],  // 0=black, 1=white
    palette: 'grayscale',
    description: 'Surface reflectivity',
  },
  'roughness_length': {
    label: 'Roughness',
    unit: 'm',
    range: [0, 2],  // ocean=0.001, forest=1-2
    palette: 'terrain',
  },
  'boundary_layer_height': {
    label: 'Boundary Layer',
    unit: 'm',
    range: [0, 4000],  // daytime convective max
    palette: 'height',
  },
  'visibility': {
    label: 'Visibility',
    unit: 'm',
    range: [0, 50000],  // 0=fog, 50km=clear
    palette: 'visibility',
  },

  // ============================================================
  // Ocean
  // ============================================================
  'ocean_u_current': {
    label: 'Ocean Current U',
    unit: 'm/s',
    range: [-3, 3],  // Gulf Stream ~2 m/s
    palette: 'diverging',
  },
  'ocean_v_current': {
    label: 'Ocean Current V',
    unit: 'm/s',
    range: [-3, 3],
    palette: 'diverging',
  },
  'sea_level_height_msl': {
    label: 'Sea Level Height',
    unit: 'm',
    range: [-2, 2],  // dynamic topography
    palette: 'diverging',
  },
  'sea_ice_thickness': {
    label: 'Sea Ice Thickness',
    unit: 'm',
    range: [0, 5],
    palette: 'ice',
  },

  // ============================================================
  // Misc
  // ============================================================
  'precipitation_type': {
    label: 'Precip Type',
    unit: 'code',
    range: [0, 3],  // categorical: none, rain, snow, mix
    palette: 'categorical',
  },
};

/**
 * Get metadata for a parameter, with fallback for unknown params
 */
export function getParamMeta(param: string): ParamMeta {
  return PARAM_METADATA[param] ?? {
    label: param,
    unit: '?',
    range: [0, 1],
    palette: 'grayscale',
  };
}

/**
 * Get all known parameter IDs
 */
export function getKnownParams(): string[] {
  return Object.keys(PARAM_METADATA);
}
