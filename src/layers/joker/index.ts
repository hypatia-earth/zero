/**
 * Joker Layer - Test case for declarative layer system
 *
 * Simplest possible user layer:
 * - No data fetching (no params)
 * - Solid color overlay
 * - Proves UI → Registry → Shader pipeline works
 *
 * When enabled, renders a solid brown color on the globe surface.
 */

import { defineLayer, withUI, withOptions, withSolidColor, withRender } from '../../services/layer/builder';

export const jokerLayer = defineLayer('joker',
  withSolidColor(),
  withUI('Joker', 'Joker', 'reference'),
  withOptions(['joker.enabled', 'joker.opacity', 'joker.color']),
  withRender({ pass: 'surface', order: 5 }),
);

/** Default Joker options for testing */
export const jokerDefaults = {
  enabled: false,
  opacity: 0.5,
  color: '#8B4513',  // Saddle brown
};

export const layer = jokerLayer;
