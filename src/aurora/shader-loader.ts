/**
 * ShaderLoader - Imports and provides access to layer shaders
 *
 * Centralizes shader imports from layer folders for use by ShaderComposer.
 * This is prep work for full shader composition - currently the shaders
 * are compiled at build time, but this structure allows for runtime
 * composition in the future.
 *
 * Shader organization per layer:
 * - Main pass shaders: blend functions for surface rendering
 * - Post pass shaders: post-processing effects (glow, etc.)
 * - Compute shaders: GPU compute for wind, pressure, etc.
 */

// Earth layer
import earthBaseShader from '../layers/earth/base.wgsl?raw';

// Sun layer - multiple shaders for different passes
import sunShader from '../layers/sun/sun.wgsl?raw';
import sunBlendShader from '../layers/sun/blend.wgsl?raw';
import sunAtmoShader from '../layers/sun/atmo.wgsl?raw';
import sunPostShader from '../layers/sun/post.wgsl?raw';

// Temperature layer
import tempShader from '../layers/temp/temp.wgsl?raw';

// Rain layer
import rainShader from '../layers/rain/rain.wgsl?raw';

// Grid layer
import gridShader from '../layers/grid/grid.wgsl?raw';
import gridTextShader from '../layers/grid/text.wgsl?raw';

// Joker layer (test layer)
import jokerShader from '../layers/joker/joker.wgsl?raw';

// Wind layer (compute + render)
import windComputeShader from '../layers/wind/compute.wgsl?raw';
import windRenderShader from '../layers/wind/render.wgsl?raw';

// Pressure layer (compute pipeline + render)
import pressureContourShader from '../layers/pressure/contour.wgsl?raw';
import pressureRegridShader from '../layers/pressure/regrid.wgsl?raw';
import pressureChaikinShader from '../layers/pressure/chaikin.wgsl?raw';
import pressureRenderShader from '../layers/pressure/render.wgsl?raw';
import pressurePrefixSumShader from '../layers/pressure/prefix-sum.wgsl?raw';

export interface LayerShaders {
  /** Main blend function shader for surface pass */
  main?: string;
  /** Post-processing shader */
  post?: string;
  /** Compute shader(s) - can be multiple for complex pipelines */
  compute?: string[];
  /** Render shader for geometry pass */
  render?: string;
}

/**
 * Get all layer shaders organized by layer ID
 *
 * Returns a map of layer ID to shader collection.
 * Each layer may have:
 * - main: blend functions for surface rendering
 * - post: post-processing effects
 * - compute: GPU compute shaders
 * - render: geometry pass rendering
 */
export function getLayerShaders(): Map<string, LayerShaders> {
  return new Map([
    ['earth', {
      main: earthBaseShader,
    }],

    ['sun', {
      // Sun has multiple shaders that compose together
      main: [sunShader, sunBlendShader, sunAtmoShader].join('\n\n'),
      post: sunPostShader,
    }],

    ['temp', {
      main: tempShader,
    }],

    ['rain', {
      main: rainShader,
    }],

    ['grid', {
      main: [gridShader, gridTextShader].join('\n\n'),
    }],

    ['joker', {
      main: jokerShader,
    }],

    ['wind', {
      compute: [windComputeShader],
      render: windRenderShader,
    }],

    ['pressure', {
      compute: [
        pressureRegridShader,
        pressureContourShader,
        pressureChaikinShader,
        pressurePrefixSumShader,
      ],
      render: pressureRenderShader,
    }],
  ]);
}

/**
 * Get main pass shaders as a flat map (layerId → shader code)
 * Used by ShaderComposer for surface pass composition
 */
export function getMainShaders(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [layerId, shaders] of getLayerShaders()) {
    if (shaders.main) {
      result.set(layerId, shaders.main);
    }
  }
  return result;
}

/**
 * Get post-process shaders as a flat map (layerId → shader code)
 * Used by ShaderComposer for post-process pass
 */
export function getPostShaders(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [layerId, shaders] of getLayerShaders()) {
    if (shaders.post) {
      result.set(layerId, shaders.post);
    }
  }
  return result;
}

/**
 * Get compute shaders for a specific layer
 */
export function getComputeShaders(layerId: string): string[] {
  const shaders = getLayerShaders().get(layerId);
  return shaders?.compute ?? [];
}

/**
 * Get render shader for a specific layer (geometry pass)
 */
export function getRenderShader(layerId: string): string | undefined {
  const shaders = getLayerShaders().get(layerId);
  return shaders?.render;
}
