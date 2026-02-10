/**
 * CreateLayerDialog - Dialog for creating user-defined layers
 *
 * Allows users to define custom visualization layers with:
 * - Layer ID and display name
 * - Data parameter selection
 * - Custom WGSL blend shader code
 * - Render order
 */

import m from 'mithril';
import type { LayerRegistryService } from '../services/layer-registry-service';
import { defineLayer, withType, withParams, withOptions, withBlend, withShader, withRender } from '../render/layer-builder';

interface CreateLayerDialogAttrs {
  layerRegistry: LayerRegistryService;
  onClose: () => void;
}

// Available data parameters for user layers
const DATA_PARAMS = [
  { value: 'temp_2m', label: 'Temperature (2m)' },
  { value: 'rain', label: 'Precipitation' },
  { value: 'pressure_msl', label: 'Pressure (MSL)' },
  { value: 'wind_u_10m', label: 'Wind U (10m)' },
  { value: 'wind_v_10m', label: 'Wind V (10m)' },
];

// Template shader for new layers
const SHADER_TEMPLATE = `// Custom blend function
// Available: color (input), lat, lon (radians), u.{layerId}Opacity
fn blend{BlendName}(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.{layerId}Opacity <= 0.0) { return color; }

  // Your visualization logic here
  // Example: simple lat-based gradient
  let t = (lat + 1.5708) / 3.1416;  // Normalize lat to 0-1
  let layerColor = vec3f(t, 0.5, 1.0 - t);

  return vec4f(mix(color.rgb, layerColor, u.{layerId}Opacity), color.a);
}
`;

interface FormState {
  id: string;
  param: string;
  shaderCode: string;
  order: number;
  error: string | null;
}

export const CreateLayerDialog: m.ClosureComponent<CreateLayerDialogAttrs> = () => {
  const state: FormState = {
    id: '',
    param: 'temp_2m',
    shaderCode: SHADER_TEMPLATE,
    order: 50,
    error: null,
  };

  function updateShaderTemplate() {
    const blendName = capitalize(state.id || 'Custom');
    state.shaderCode = SHADER_TEMPLATE
      .replace(/{BlendName}/g, blendName)
      .replace(/{layerId}/g, state.id || 'custom');
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function validateAndCreate(registry: LayerRegistryService, onClose: () => void) {
    state.error = null;

    // Validate ID
    if (!state.id || !/^[a-z][a-z0-9_]*$/.test(state.id)) {
      state.error = 'ID must start with lowercase letter, contain only a-z, 0-9, _';
      return;
    }

    // Check for duplicate (unless it's a try layer being saved)
    const existing = registry.get(state.id);
    if (existing && existing.isBuiltIn) {
      state.error = `Cannot override built-in layer "${state.id}"`;
      return;
    }

    // Validate shader has blend function
    const blendFn = `blend${capitalize(state.id)}`;
    if (!state.shaderCode.includes(`fn ${blendFn}`)) {
      state.error = `Shader must define function: fn ${blendFn}(...)`;
      return;
    }

    // If already registered (from Try), just keep it
    if (existing) {
      console.log(`[CreateLayer] Saved user layer: ${state.id} (index ${existing.userLayerIndex})`);
      // TODO: persist to IDB
      onClose();
      return;
    }

    // Create layer declaration (without userLayerIndex - registry assigns it)
    const declaration = defineLayer(state.id,
      withType('texture'),
      withParams([state.param]),
      withOptions([`${state.id}.enabled`, `${state.id}.opacity`]),
      withBlend(blendFn),
      withShader('main', state.shaderCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    // Register with auto-assigned index
    const layer = registry.registerUserLayer(declaration);
    if (!layer) {
      state.error = 'No free layer slots (max 32 user layers)';
      return;
    }

    console.log(`[CreateLayer] Saved user layer: ${state.id} (index ${layer.userLayerIndex})`);
    // TODO: persist to IDB
    onClose();
  }

  function tryLayer(registry: LayerRegistryService) {
    state.error = null;

    if (!state.id) {
      state.error = 'Layer ID is required';
      return;
    }

    // Validate shader has blend function
    const blendFn = `blend${capitalize(state.id)}`;
    if (!state.shaderCode.includes(`fn ${blendFn}`)) {
      state.error = `Shader must define function: fn ${blendFn}(...)`;
      return;
    }

    // Check if layer already exists
    const existing = registry.get(state.id);
    if (existing) {
      // Update shader code in existing layer
      if (existing.shaders) {
        existing.shaders.main = state.shaderCode;
      }
      // TODO: trigger recompilation
      console.log(`[CreateLayer] Updated layer: ${state.id} (index ${existing.userLayerIndex})`);
      return;
    }

    // Create layer declaration
    const declaration = defineLayer(state.id,
      withType('texture'),
      withParams([state.param]),
      withOptions([`${state.id}.enabled`, `${state.id}.opacity`]),
      withBlend(blendFn),
      withShader('main', state.shaderCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    // Register with auto-assigned index
    const layer = registry.registerUserLayer(declaration);
    if (!layer) {
      state.error = 'No free layer slots (max 32 user layers)';
      return;
    }

    console.log(`[CreateLayer] Try layer: ${state.id} (index ${layer.userLayerIndex})`);
    // TODO: trigger shader recompilation in worker
  }

  function deleteLayer(registry: LayerRegistryService, onClose: () => void) {
    const layer = state.id ? registry.get(state.id) : null;
    if (layer && !layer.isBuiltIn) {
      registry.unregisterUserLayer(state.id);
      console.log(`[CreateLayer] Deleted layer: ${state.id}`);
      // TODO: remove from IDB, trigger recompilation
    }
    onClose();
  }

  return {
    view({ attrs }) {
      const { layerRegistry, onClose } = attrs;
      const exists = state.id && layerRegistry.get(state.id);

      return m('.dialog.create-layer', [
        m('.backdrop', { onclick: onClose }),
        m('.window', [
          // Header
          m('.header', [
            m('h2', 'Create Layer'),
            m('button.close', { onclick: onClose }, '×'),
          ]),

          // Content
          m('.content', [
            // Layer ID
            m('.field', [
              m('label', 'Layer ID'),
              m('input[type=text]', {
                placeholder: 'e.g., mytemp',
                value: state.id,
                oninput: (e: Event) => {
                  state.id = (e.target as HTMLInputElement).value.toLowerCase();
                  updateShaderTemplate();
                },
              }),
              m('.hint', 'Unique identifier (lowercase, no spaces)'),
            ]),

            // Data parameter
            m('.field', [
              m('label', 'Data Parameter'),
              m('select', {
                value: state.param,
                onchange: (e: Event) => {
                  state.param = (e.target as HTMLSelectElement).value;
                },
              }, DATA_PARAMS.map(p =>
                m('option', { value: p.value }, p.label)
              )),
            ]),

            // Render order
            m('.field', [
              m('label', 'Render Order'),
              m('input[type=number]', {
                min: 0,
                max: 100,
                value: state.order,
                oninput: (e: Event) => {
                  state.order = parseInt((e.target as HTMLInputElement).value) || 50;
                },
              }),
              m('.hint', 'Lower = behind, higher = on top (earth=0, temp=10)'),
            ]),

            // Shader code
            m('.field.shader', [
              m('label', 'Blend Shader (WGSL)'),
              m('textarea', {
                value: state.shaderCode,
                oninput: (e: Event) => {
                  state.shaderCode = (e.target as HTMLTextAreaElement).value;
                },
              }),
            ]),

            // Error message
            state.error && m('.error', state.error),
          ]),

          // Footer
          m('.footer', [
            m('.left', [
              m('button', {
                onclick: () => tryLayer(layerRegistry),
              }, 'Try'),
              exists && m('button.danger', {
                onclick: () => deleteLayer(layerRegistry, onClose),
              }, 'Delete'),
            ]),
            m('.right', [
              m('button', { onclick: onClose }, 'Cancel'),
              m('button.primary', {
                onclick: () => validateAndCreate(layerRegistry, onClose),
              }, 'Save'),
            ]),
          ]),
        ]),
      ]);
    },
  };
};
