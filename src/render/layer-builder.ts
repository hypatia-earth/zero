/**
 * Layer Builder - Fluent API for declaring layers
 *
 * Usage:
 *   const tempLayer = defineLayer('temp',
 *     withParams(['temperature_2m']),
 *     withOptions(['temp.enabled', 'temp.opacity', 'temp.palette']),
 *     withPalette({ source: 'temp.palette', range: [-40, 50] }),
 *     withInterpolation('lerp'),
 *     withRender({ pass: 'surface', order: 10 }),
 *   );
 */

import type { LayerDeclaration, LayerType, ComputeTrigger, RenderPass, LayerShaders } from '../services/layer-service';

export interface LayerFeature {
  apply(declaration: Partial<LayerDeclaration>): Partial<LayerDeclaration>;
}

export function defineLayer(id: string, ...features: LayerFeature[]): LayerDeclaration {
  let declaration: Partial<LayerDeclaration> = { id };

  for (const feature of features) {
    declaration = feature.apply(declaration);
  }

  // Ensure required fields
  if (!declaration.type) {
    declaration.type = 'texture';  // default type
  }

  return declaration as LayerDeclaration;
}

export function withType(type: LayerType): LayerFeature {
  return {
    apply: (d) => ({ ...d, type }),
  };
}

export function withParams(params: string[]): LayerFeature {
  return {
    apply: (d) => ({ ...d, params }),
  };
}

export function withOptions(paths: string[]): LayerFeature {
  return {
    apply: (d) => ({ ...d, options: paths }),
  };
}

export function withBlend(blendFn: string): LayerFeature {
  return {
    apply: (d) => ({ ...d, blendFn }),
  };
}

export function withPost(postFn: string): LayerFeature {
  return {
    apply: (d) => ({ ...d, postFn }),
  };
}

export function withCompute(triggers: Record<string, ComputeTrigger>): LayerFeature {
  return {
    apply: (d) => ({ ...d, triggers, type: 'geometry' }),
  };
}

export function withRender(config: { pass?: RenderPass; order?: number; topology?: 'triangle-list' | 'line-list' }): LayerFeature {
  return {
    apply: (d) => {
      const result = { ...d };
      if (config.pass) result.pass = config.pass;
      if (config.order !== undefined) result.order = config.order;
      if (config.topology) result.topology = config.topology;
      return result;
    },
  };
}

export function withInterpolation(mode: 'lerp' | 'none'): LayerFeature {
  return {
    apply: (d) => ({ ...d, interpolation: mode }),
  };
}

export function withSolidColor(): LayerFeature {
  return {
    apply: (d) => ({ ...d, type: 'solid' }),
  };
}

export function asBuiltIn(): LayerFeature {
  return {
    apply: (d) => ({ ...d, isBuiltIn: true }),
  };
}

/** Add shader code to layer declaration */
export function withShader(type: keyof LayerShaders, code: string): LayerFeature {
  return {
    apply: (d) => {
      const shaders = { ...d.shaders } as LayerShaders;
      if (type === 'compute') {
        shaders.compute = [...(shaders.compute || []), code];
      } else {
        shaders[type] = code;
      }
      return { ...d, shaders };
    },
  };
}
