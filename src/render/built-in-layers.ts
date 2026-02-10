/**
 * Built-in Layer Declarations
 *
 * Imports layer declarations from layer folders.
 * These are registered in LayerRegistryService at bootstrap.
 */

import type { LayerRegistryService } from '../services/layer-registry-service';
import { shaderComposer } from './shader-composer';
import { USE_DECLARATIVE_LAYERS } from '../config/feature-flags';

// Import layer declarations from folders
import { layer as earthLayer } from '../layers/earth';
import { layer as sunLayer } from '../layers/sun';
import { layer as gridLayer } from '../layers/grid';
import { layer as tempLayer } from '../layers/temp';
import { layer as rainLayer } from '../layers/rain';
import { layer as pressureLayer } from '../layers/pressure';
import { layer as windLayer } from '../layers/wind';

// Re-export for consumers
export { earthLayer, sunLayer, gridLayer, tempLayer, rainLayer, pressureLayer, windLayer };

/** All built-in layer declarations */
export const builtInLayers = [
  earthLayer,
  sunLayer,
  gridLayer,
  tempLayer,
  rainLayer,
  pressureLayer,
  windLayer,
];

/** Register all built-in layers in the registry */
export function registerBuiltInLayers(registry: LayerRegistryService): void {
  for (const layer of builtInLayers) {
    registry.register(layer);
  }
  console.log('[Layers] Registered:', registry.getAll().map(l => l.id).join(', '));

  // When declarative mode is on, show what ShaderComposer would generate
  if (USE_DECLARATIVE_LAYERS) {
    shaderComposer.compose(registry.getAll());
  }
}
