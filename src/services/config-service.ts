/**
 * ConfigService - Configuration for Hypatia Zero
 *
 * Loads runtime config from /config/zero.config.json in production,
 * falls back to compiled defaults in development.
 *
 * Layer UI config (label, buttonLabel, category) comes from LayerService.
 * Extra layer config (slabs, etc.) still comes from defaults.ts.
 */

import { defaultConfig, EARTH_RADIUS } from '../config/defaults';
import type { ZeroConfig, TLayer, TParam, LayerConfig, AppConfig, DiscoveryConfig, TLayerCategory } from '../config/types';
import { deepMerge } from '../utils/object';
import type { LayerService } from './layer';

export class ConfigService {
  private config: ZeroConfig = defaultConfig;
  private initialized = false;
  private layerService: LayerService | null = null;

  /** Set LayerService reference (called after both services created) */
  setLayerService(layerService: LayerService): void {
    this.layerService = layerService;
  }

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
    if (!this.layerService) {
      throw new Error('ConfigService.getLayers() called before LayerService was set');
    }
    return this.layerService.getBuiltIn().map(decl => ({
      id: decl.id as TLayer,
      label: decl.label ?? decl.id,
      buttonLabel: decl.buttonLabel ?? decl.id,
      category: decl.category ?? 'custom' as TLayerCategory,
      ...(decl.params && { params: decl.params as TParam[] }),
      ...(decl.slabs && { slabs: decl.slabs }),
    }));
  }

  getLayer(id: TLayer): LayerConfig | undefined {
    return this.getLayers().find(l => l.id === id);
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

  /** Find which layer provides a given param (e.g., "temperature_2m" → "temp") */
  getLayerForParam(param: string): TLayer | undefined {
    if (!this.layerService) return undefined;
    const layers = this.layerService.getLayersForParam(param);
    const builtIn = layers.find(l => l.isBuiltIn);
    return builtIn?.id as TLayer | undefined;
  }
}
