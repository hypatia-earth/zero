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
// Uses getUserLayerOpacity(index) for user layer uniform access
const SHADER_TEMPLATE = `// Custom blend function for user layer
// Uses getUserLayerOpacity(index) to access opacity uniform
fn blend{BlendName}(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getUserLayerOpacity({userLayerIndex}u);
  if (opacity <= 0.0) { return color; }

  // Your visualization logic here
  // Example: simple lat-based gradient
  let t = (lat + 1.5708) / 3.1416;  // Normalize lat to 0-1
  let layerColor = vec3f(t, 0.5, 1.0 - t);

  return vec4f(mix(color.rgb, layerColor, opacity), color.a);
}
`;

interface FormState {
  id: string;
  param: string;
  shaderCode: string;
  order: number;
  userLayerIndex: number | null;  // Assigned on first Try/Save
  error: string | null;
}

export const CreateLayerDialog: m.ClosureComponent<CreateLayerDialogAttrs> = () => {
  const state: FormState = {
    id: '',
    param: 'temp_2m',
    shaderCode: SHADER_TEMPLATE,
    order: 50,
    userLayerIndex: null,
    error: null,
  };

  function updateShaderTemplate() {
    const blendName = capitalize(state.id || 'Custom');
    // Keep {userLayerIndex} placeholder - replaced when index is assigned
    state.shaderCode = SHADER_TEMPLATE
      .replace(/{BlendName}/g, blendName);
  }

  /** Replace index placeholder in shader code with actual index */
  function finalizeShaderCode(index: number): string {
    return state.shaderCode.replace(/{userLayerIndex}/g, String(index));
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

    // If already registered (from Try), just save to IDB
    if (existing) {
      console.log(`[CreateLayer] Saved user layer: ${state.id} (index ${existing.userLayerIndex})`);
      // TODO: persist to IDB
      onClose();
      return;
    }

    // Allocate index first
    const index = registry.allocateUserIndex();
    if (index === null) {
      state.error = 'No free layer slots (max 32 user layers)';
      return;
    }

    // Finalize shader code with index
    const finalizedCode = finalizeShaderCode(index);

    // Create and register layer
    const declaration = defineLayer(state.id,
      withType('texture'),
      withParams([state.param]),
      withOptions([`${state.id}.enabled`, `${state.id}.opacity`]),
      withBlend(blendFn),
      withShader('main', finalizedCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    const layer: import('../services/layer-registry-service').LayerDeclaration = {
      ...declaration,
      userLayerIndex: index,
      isBuiltIn: false,
    };
    registry.register(layer);

    console.log(`[CreateLayer] Saved user layer: ${state.id} (index ${index})`);
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
    if (existing && existing.userLayerIndex !== undefined) {
      // Update shader code in existing layer with finalized index
      const finalizedCode = finalizeShaderCode(existing.userLayerIndex);
      if (existing.shaders) {
        existing.shaders.main = finalizedCode;
      }
      state.userLayerIndex = existing.userLayerIndex;
      // TODO: trigger recompilation in worker
      console.log(`[CreateLayer] Updated layer: ${state.id} (index ${existing.userLayerIndex})`);
      return;
    }

    // Allocate index first so we can finalize shader
    const index = registry.allocateUserIndex();
    if (index === null) {
      state.error = 'No free layer slots (max 32 user layers)';
      return;
    }
    state.userLayerIndex = index;

    // Finalize shader code with actual index
    const finalizedCode = finalizeShaderCode(index);

    // Create layer declaration with finalized shader
    const declaration = defineLayer(state.id,
      withType('texture'),
      withParams([state.param]),
      withOptions([`${state.id}.enabled`, `${state.id}.opacity`]),
      withBlend(blendFn),
      withShader('main', finalizedCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    // Register layer (index already allocated)
    const layer: import('../services/layer-registry-service').LayerDeclaration = {
      ...declaration,
      userLayerIndex: index,
      isBuiltIn: false,
    };
    registry.register(layer);

    console.log(`[CreateLayer] Try layer: ${state.id} (index ${index})`);
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
