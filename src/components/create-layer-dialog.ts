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
import { effect } from '@preact/signals-core';
import type { LayerRegistryService, LayerDeclaration } from '../services/layer-registry-service';
import type { AuroraService } from '../services/aurora-service';
import { defineLayer, withType, withParams, withOptions, withBlend, withShader, withRender } from '../render/layer-builder';

interface CreateLayerDialogAttrs {
  layerRegistry: LayerRegistryService;
  auroraService: AuroraService;
  editLayerId?: string | null;
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
  opacity: number;
  userLayerIndex: number | null;  // Assigned on first Try/Save
  error: string | null;
}

export const CreateLayerDialog: m.ClosureComponent<CreateLayerDialogAttrs> = () => {
  const state: FormState = {
    id: '',
    param: 'temp_2m',
    shaderCode: SHADER_TEMPLATE,
    order: 50,
    opacity: 1.0,
    userLayerIndex: null,
    error: null,
  };

  let initialized = false;
  // Track layer suspended for preview (to restore on cancel)
  let suspendedLayer: LayerDeclaration | null = null;

  function initFromLayer(registry: LayerRegistryService, layerId: string) {
    const layer = registry.get(layerId);
    if (!layer) return;

    state.id = layer.id;
    state.param = layer.params?.[0] ?? 'temp_2m';
    state.shaderCode = layer.shaders?.main ?? SHADER_TEMPLATE;
    state.order = layer.order ?? 50;
    state.opacity = registry.getUserLayerOpacity(layerId);
    state.userLayerIndex = layer.userLayerIndex ?? null;
  }

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

  function validateAndCreate(registry: LayerRegistryService, aurora: AuroraService, onClose: () => void) {
    state.error = null;

    // Validate ID
    if (!state.id || !/^[a-z][a-z0-9_]*$/.test(state.id)) {
      state.error = 'ID must start with lowercase letter, contain only a-z, 0-9, _';
      return;
    }

    // Check for duplicate with built-in
    const existing = registry.get(state.id);
    if (existing?.isBuiltIn) {
      state.error = `Cannot override built-in layer "${state.id}"`;
      return;
    }

    // Validate shader has blend function
    const blendFn = `blend${capitalize(state.id)}`;
    if (!state.shaderCode.includes(`fn ${blendFn}`)) {
      state.error = `Shader must define function: fn ${blendFn}(...)`;
      return;
    }

    // Unregister preview from worker first
    if (registry.hasPreview()) {
      aurora.send({ type: 'unregisterUserLayer', layerId: '_preview' });
    }

    // Allocate permanent index
    const index = registry.allocateUserIndex();
    if (index === null) {
      state.error = 'No free layer slots (max 31 user layers)';
      return;
    }

    // Finalize shader code with permanent index
    const finalizedCode = finalizeShaderCode(index);

    // Unregister preview from registry
    registry.unregisterPreview();

    // Create and register permanent layer
    const declaration = defineLayer(state.id,
      withType('texture'),
      withParams([state.param]),
      withOptions([`${state.id}.enabled`, `${state.id}.opacity`]),
      withBlend(blendFn),
      withShader('main', finalizedCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    const layer: LayerDeclaration = {
      ...declaration,
      userLayerIndex: index,
      isBuiltIn: false,
    };
    registry.register(layer);
    registry.setUserLayerOpacity(state.id, state.opacity);

    // Send to worker for shader recompilation
    aurora.send({ type: 'registerUserLayer', layer });
    // Set initial opacity
    aurora.send({ type: 'setUserLayerOpacity', layerIndex: index, opacity: state.opacity });

    console.log(`[CreateLayer] Saved: ${state.id} (index ${index})`);
    suspendedLayer = null;  // Don't restore old layer - new one saved
    // TODO: persist to IDB
    onClose();
  }

  function tryLayer(registry: LayerRegistryService, aurora: AuroraService) {
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

    // If editing existing layer, unregister it from worker to avoid duplicate blend function
    const existingLayer = registry.get(state.id);
    if (existingLayer && !existingLayer.isBuiltIn) {
      suspendedLayer = existingLayer;  // Save for restore on cancel
      aurora.send({ type: 'unregisterUserLayer', layerId: state.id });
    }

    // Finalize shader code with preview index (31)
    const finalizedCode = finalizeShaderCode(31);

    // Create preview layer declaration
    const declaration = defineLayer('_preview',
      withType('texture'),
      withParams([state.param]),
      withOptions([]),  // Preview has no options
      withBlend(blendFn),
      withShader('main', finalizedCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    // Register as preview (replaces any existing preview)
    const layer = registry.registerPreview(declaration);

    // Send to worker for shader recompilation
    aurora.send({ type: 'registerUserLayer', layer });

    console.log(`[CreateLayer] Preview: ${state.id} (index 31)`);
    m.redraw();  // Update UI (enables Save button)
  }

  function deleteLayer(registry: LayerRegistryService, aurora: AuroraService, onClose: () => void) {
    // Delete permanent layer if exists
    const layer = state.id ? registry.get(state.id) : null;
    if (layer && !layer.isBuiltIn) {
      registry.unregisterUserLayer(state.id);
      aurora.send({ type: 'unregisterUserLayer', layerId: state.id });
      console.log(`[CreateLayer] Deleted: ${state.id}`);
      // TODO: remove from IDB
    }
    suspendedLayer = null;  // Don't restore - layer was deleted
    // Also clean up preview
    cleanupPreview(registry, aurora);
    onClose();
  }

  function cleanupPreview(registry: LayerRegistryService, aurora: AuroraService) {
    if (registry.hasPreview()) {
      registry.unregisterPreview();
      aurora.send({ type: 'unregisterUserLayer', layerId: '_preview' });
      console.log('[CreateLayer] Preview cleaned up');
    }
  }

  function handleClose(registry: LayerRegistryService, aurora: AuroraService, onClose: () => void) {
    cleanupPreview(registry, aurora);
    // Restore suspended layer if user cancels during edit
    if (suspendedLayer) {
      aurora.send({ type: 'registerUserLayer', layer: suspendedLayer });
      console.log(`[CreateLayer] Restored: ${suspendedLayer.id}`);
      suspendedLayer = null;
    }
    onClose();
  }

  let disposeErrorEffect: (() => void) | null = null;

  // Drag state
  const drag = {
    isFloating: false,
    isDragging: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  };

  function resetDrag() {
    drag.isDragging = false;
    drag.offsetX = 0;
    drag.offsetY = 0;
  }

  function resetState() {
    state.id = '';
    state.param = 'temp_2m';
    state.shaderCode = SHADER_TEMPLATE;
    state.order = 50;
    state.opacity = 1.0;
    state.userLayerIndex = null;
    state.error = null;
    initialized = false;
    suspendedLayer = null;
  }

  return {
    oncreate({ attrs }) {
      // Reset state when dialog opens
      resetState();
      attrs.auroraService.userLayerError.value = null;

      // Watch for shader compilation errors from worker
      disposeErrorEffect = effect(() => {
        const err = attrs.auroraService.userLayerError.value;
        if (err && err.layerId === '_preview') {
          state.error = `Shader error: ${err.error}`;
          m.redraw();
        }
      });
    },

    onremove() {
      disposeErrorEffect?.();
    },

    view({ attrs }) {
      const { layerRegistry, auroraService, editLayerId, onClose } = attrs;
      const isEditing = !!editLayerId;

      // Initialize from existing layer on first render
      if (!initialized && editLayerId) {
        initFromLayer(layerRegistry, editLayerId);
        initialized = true;
      }

      const exists = state.id && layerRegistry.get(state.id);
      const close = () => { resetDrag(); handleClose(layerRegistry, auroraService, onClose); };

      // Desktop detection
      const isDesktop = window.innerWidth >= 768;

      // Drag handlers
      const onMouseDown = (e: MouseEvent) => {
        if (!isDesktop || !drag.isFloating) return;
        if ((e.target as HTMLElement).tagName === 'BUTTON') return;
        drag.isDragging = true;
        drag.startX = e.clientX - drag.offsetX;
        drag.startY = e.clientY - drag.offsetY;

        const onMouseMove = (ev: MouseEvent) => {
          if (!drag.isDragging) return;
          drag.offsetX = ev.clientX - drag.startX;
          drag.offsetY = ev.clientY - drag.startY;
          m.redraw();
        };

        const onMouseUp = () => {
          drag.isDragging = false;
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      };

      const windowStyle = drag.isFloating && (drag.offsetX || drag.offsetY)
        ? `transform: translate(${drag.offsetX}px, ${drag.offsetY}px)`
        : '';

      return m('.dialog.create-layer', { class: drag.isFloating ? 'floating' : '' }, [
        m('.backdrop', { onclick: close }),
        m('.window', {
          class: drag.isDragging ? 'dragging' : '',
          style: windowStyle,
        }, [
          // Header
          m('.header', { onmousedown: onMouseDown }, [
            m('h2', isEditing ? 'Edit Layer' : 'Create Layer'),
            m('.bar', [
              isDesktop && m('button.float-toggle', {
                onclick: (e: Event) => {
                  e.stopPropagation();
                  drag.isFloating = !drag.isFloating;
                  if (!drag.isFloating) resetDrag();
                  m.redraw();
                },
                title: drag.isFloating ? 'Disable floating' : 'Keep floating',
              }, drag.isFloating ? '◎' : '○'),
              m('button.close', { onclick: close }, '×'),
            ]),
          ]),

          // Content
          m('.content', [
            // Layer ID
            m('.field', [
              m('label', 'Layer ID'),
              m('input[type=text]', {
                placeholder: 'e.g., mytemp',
                disabled: isEditing,
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

            // Opacity slider (only active after Try or when editing)
            m('.field', [
              m('label', `Opacity: ${Math.round(state.opacity * 100)}%`),
              m('input[type=range]', {
                min: 0,
                max: 100,
                value: state.opacity * 100,
                disabled: !layerRegistry.hasPreview() && !isEditing,
                oninput: (e: Event) => {
                  state.opacity = parseInt((e.target as HTMLInputElement).value) / 100;
                  // Send to worker in real-time
                  const index = isEditing ? layerRegistry.get(editLayerId!)?.userLayerIndex : 31;
                  if (index !== undefined) {
                    auroraService.send({ type: 'setUserLayerOpacity', layerIndex: index, opacity: state.opacity });
                  }
                },
              }),
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
                onclick: () => tryLayer(layerRegistry, auroraService),
              }, 'Try'),
              exists && m('button.danger', {
                onclick: () => deleteLayer(layerRegistry, auroraService, onClose),
              }, 'Delete'),
            ]),
            m('.right', [
              m('button', { onclick: close }, 'Cancel'),
              m('button.primary', {
                disabled: !layerRegistry.hasPreview(),
                onclick: () => validateAndCreate(layerRegistry, auroraService, onClose),
              }, 'Save'),
            ]),
          ]),
        ]),
      ]);
    },
  };
};
