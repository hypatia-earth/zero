/**
 * Built-in Layer Declarations
 *
 * Imports layer declarations from layer folders.
 * These are registered in LayerService at bootstrap.
 */

import type { LayerService } from '../services/layer-service';
import { shaderComposer } from '../render/shader-composer';
import { USE_DECLARATIVE_LAYERS } from '../config/feature-flags';

// Import layer declarations from folders
import { layer as earthLayer } from './earth';
import { layer as sunLayer } from './sun';
import { layer as gridLayer } from './grid';
import { layer as tempLayer } from './temp';
import { layer as rainLayer } from './rain';
import { layer as pressureLayer } from './pressure';
import { layer as windLayer } from './wind';

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
export function registerBuiltInLayers(registry: LayerService): void {
  for (const layer of builtInLayers) {
    registry.register(layer);
  }
  console.log('[Layers] Registered:', registry.getAll().map(l => l.id).join(', '));

  // When declarative mode is on, show what ShaderComposer would generate
  if (USE_DECLARATIVE_LAYERS) {
    shaderComposer.compose(registry.getAll());
  }
}
