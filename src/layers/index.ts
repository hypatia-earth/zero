/**
 * Built-in Layer Declarations
 *
 * Imports layer declarations from layer folders.
 * Registered in LayerService.registerBuiltInLayers() at bootstrap.
 */

// Import layer declarations from folders
import { layer as earthLayer } from './earth';
import { layer as sunLayer } from './sun';
import { layer as graticuleLayer } from './graticule';
import { layer as tempLayer } from './temp';
import { layer as rainLayer } from './rain';
import { layer as pressureLayer } from './pressure';
import { layer as windLayer } from './wind';

// Re-export for consumers
export { earthLayer, sunLayer, graticuleLayer, tempLayer, rainLayer, pressureLayer, windLayer };

/** All built-in layer declarations */
export const builtInLayers = [
  earthLayer,
  sunLayer,
  graticuleLayer,
  tempLayer,
  rainLayer,
  pressureLayer,
  windLayer,
];
