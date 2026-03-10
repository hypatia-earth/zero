/**
 * Stub Layers — Binding stress test (localhost only)
 *
 * Registers all texture-backed stub layers alongside real layers.
 * Validates that the full target binding table compiles:
 * - 6 storage buffers (2 fixed + 4 params)
 * - 12 sampled textures (9 fixed + 3 texture params)
 *
 * Usage: import { registerStubs } from './stubs' and call in bootstrap.
 */

import { layer as seaIceLayer } from './sea-ice';
import { layer as oceanTempLayer } from './ocean-temp';
import { layer as wetBulbLayer } from './wet-bulb';

import type { LayerDeclaration } from '../services/layer/layer-service';

export const stubLayers: LayerDeclaration[] = [
  seaIceLayer,
  oceanTempLayer,
  wetBulbLayer,
];
