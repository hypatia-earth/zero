/**
 * ConfigService - Static configuration for Hypatia Zero
 */

import { defaultConfig, EARTH_RADIUS } from '../config/defaults';
import type { ZeroConfig, LayerId, LayerConfig } from '../config/types';

export class ConfigService {
  private config: ZeroConfig = defaultConfig;

  getConfig(): ZeroConfig {
    return this.config;
  }

  getDataBaseUrl(): string {
    return this.config.dataBaseUrl;
  }

  getDataWindowDays(): number {
    return this.config.dataWindowDays;
  }

  getPrefetchCount(): number {
    return this.config.prefetchCount;
  }

  getCameraConfig(): ZeroConfig['camera'] {
    return this.config.camera;
  }

  getLayers(): LayerConfig[] {
    return this.config.layers;
  }

  getLayer(id: LayerId): LayerConfig | undefined {
    return this.config.layers.find(l => l.id === id);
  }

  getDefaultLayers(): LayerId[] {
    return this.config.defaultLayers;
  }

  getEarthRadius(): number {
    return EARTH_RADIUS;
  }
}
