/**
 * ConfigService - Configuration for Hypatia Zero
 *
 * Loads runtime config from /config/zero.config.json in production,
 * falls back to compiled defaults in development.
 */

import { defaultConfig, EARTH_RADIUS } from '../config/defaults';
import type { ZeroConfig, LayerId, LayerConfig, AppConfig, DiscoveryConfig } from '../config/types';

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
      const response = await fetch('/config/zero.config.json');
      if (response.ok) {
        const runtimeConfig = await response.json();
        this.config = this.deepMerge(defaultConfig, runtimeConfig);
        console.log(`[Config] Loaded: ${this.config.app.name} v${this.config.app.version} (${this.config.app.environment})`);
      } else {
        console.log('[Config] No runtime config, using defaults');
      }
    } catch {
      console.log('[Config] Failed to load runtime config, using defaults');
    }

    this.initialized = true;
  }

  private deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const result = { ...target };
    for (const key in source) {
      const sourceVal = source[key];
      const targetVal = target[key];
      if (sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal) && targetVal) {
        (result as Record<string, unknown>)[key] = this.deepMerge(
          targetVal as object,
          sourceVal as object
        );
      } else if (sourceVal !== undefined) {
        (result as Record<string, unknown>)[key] = sourceVal;
      }
    }
    return result;
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

  getDataWindowDays(): number {
    return this.config.dataWindowDays;
  }

  getPrefetchCount(): number {
    return this.config.prefetchCount;
  }

  getGpuBudgetMB(): number {
    return this.config.gpuBudgetMB;
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

  getDiscovery(): DiscoveryConfig {
    return this.config.discovery;
  }

  getEarthRadius(): number {
    return EARTH_RADIUS;
  }
}
