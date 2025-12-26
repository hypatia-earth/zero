/**
 * ConfigService - Configuration for Hypatia Zero
 *
 * Loads runtime config from /config/zero.config.json in production,
 * falls back to compiled defaults in development.
 */

import { defaultConfig, EARTH_RADIUS } from '../config/defaults';
import type { ZeroConfig, TLayer, LayerConfig, AppConfig, DiscoveryConfig } from '../config/types';
import { deepMerge } from '../utils/object';

export class ConfigService {
  private config: ZeroConfig = defaultConfig;
  private initialized = false;

  /**
   * Initialize config by loading runtime overrides.
   * Call this before using any config values.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}config/zero.config.json`);
      if (response.ok) {
        const runtimeConfig = await response.json();
        this.config = deepMerge(defaultConfig, runtimeConfig);
        console.log(`[Config] Loaded: ${this.config.app.name} v${this.config.app.version} (${this.config.app.environment})`);
      } else {
        console.log('[Config] No runtime config, using defaults');
      }
    } catch {
      console.log('[Config] Failed to load runtime config, using defaults');
    }

    this.initialized = true;
  }

  getConfig(): ZeroConfig {
    return this.config;
  }

  getApp(): AppConfig {
    return this.config.app;
  }

  getDataBaseUrl(): string {
    return this.config.dataBaseUrl;
  }

  getGpuConfig(): ZeroConfig['gpu'] {
    return this.config.gpu;
  }

  getCameraConfig(): ZeroConfig['camera'] {
    return this.config.camera;
  }

  getLayers(): LayerConfig[] {
    return this.config.layers;
  }

  getLayer(id: TLayer): LayerConfig | undefined {
    return this.config.layers.find(l => l.id === id);
  }

  getDefaultLayers(): TLayer[] {
    return this.config.defaultLayers;
  }

  getReadyLayers(): TLayer[] {
    return this.config.readyLayers;
  }

  getDiscovery(): DiscoveryConfig {
    return this.config.discovery;
  }

  getEarthRadius(): number {
    return EARTH_RADIUS;
  }
}
