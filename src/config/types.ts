/**
 * Configuration types for Hypatia Zero
 */

export type LayerId = 'earth' | 'sun' | 'grid' | 'temp' | 'rain';

export interface LayerConfig {
  id: LayerId;
  label: string;
  category: 'base' | 'weather' | 'overlay';
  defaultEnabled: boolean;
}

export interface ZeroConfig {
  /** Open-Meteo S3 base URL */
  dataBaseUrl: string;

  /** Data window in days (±days from today) */
  dataWindowDays: number;

  /** Number of timesteps to prefetch */
  prefetchCount: number;

  /** Camera constraints */
  camera: {
    minDistance: number;
    maxDistance: number;
    defaultDistance: number;
  };

  /** Layer definitions */
  layers: LayerConfig[];

  /** Default active layers */
  defaultLayers: LayerId[];
}
