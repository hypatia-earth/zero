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
import type { LayerService, LayerDeclaration } from '../services/layer/layer-service';
import type { AuroraService } from '../services/aurora-service';
import type { DialogService } from '../services/dialog-service';
import { defineLayer, withType, withParams, withOptions, withBlend, withShader, withRender } from '../services/layer/builder';
import { DialogHeader } from './dialog-header';
import { PARAM_METADATA, getParamMeta, getCustomLayerParams, type ParamMeta } from '../config/param-metadata';

interface CreateLayerDialogAttrs {
  layerRegistry: LayerService;
  auroraService: AuroraService;
  dialogService: DialogService;
}

// Params available for custom layers (from metadata)
const ALLOWED_PARAMS = getCustomLayerParams();

const DEFAULT_PARAM = 'temperature_2m' satisfies keyof typeof PARAM_METADATA;

// Generate sampler function name from param (e.g., 'temperature_2m' -> 'sampleParam_temperature_2m')
function getSamplerName(param: string): string {
  const safeName = param.replace(/[^a-zA-Z0-9]/g, '_');
  return `sampleParam_${safeName}`;
}

// Build DATA_PARAMS from metadata
const DATA_PARAMS = ALLOWED_PARAMS.map(p => ({
  value: p,
  label: PARAM_METADATA[p]!.label
}));

// Template shader for new layers
// Placeholders: {BlendName}, {userLayerIndex}, {paletteMin}, {paletteMax}, {samplerFn}
const SHADER_TEMPLATE = `// Custom blend function - red-green palette
fn blend{BlendName}(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getUserLayerOpacity({userLayerIndex}u);
  if (opacity <= 0.0) { return color; }

  // Sample data using dynamic param sampler (handles interpolation)
  let cell = o1280LatLonToCell(lat, lon);
  let value = {samplerFn}(cell);

  // Normalize to 0-1 and apply red-green palette
  let vMin = {paletteMin};
  let vMax = {paletteMax};
  let t = clamp((value - vMin) / (vMax - vMin), 0.0, 1.0);
  let layerColor = vec3f(1.0 - t, t, 0.0);  // red → green

  return vec4f(mix(color.rgb, layerColor, opacity), color.a);
}
`;

interface FormState {
  id: string;
  param: string;
  paramMeta: ParamMeta;
  shaderCode: string;
  order: number;
  opacity: number;
  userLayerIndex: number | null;  // Assigned on first Try/Save
  error: string | null;
}

export const CreateLayerDialog: m.ClosureComponent<CreateLayerDialogAttrs> = () => {
  const state: FormState = {
    id: '',
    param: DEFAULT_PARAM,
    paramMeta: getParamMeta(DEFAULT_PARAM),
    shaderCode: SHADER_TEMPLATE,
    order: 50,
    opacity: 0.5,
    userLayerIndex: null,
    error: null,
  };

  let initialized = false;
  // Track layer suspended for preview (to restore on cancel)
  let suspendedLayer: LayerDeclaration | null = null;

  function initFromLayer(registry: LayerService, layerId: string) {
    const layer = registry.get(layerId);
    if (!layer) return;

    state.id = layer.id;
    state.param = layer.params?.[0] ?? DEFAULT_PARAM;
    state.paramMeta = getParamMeta(state.param);
    state.shaderCode = layer.shaders?.main ?? SHADER_TEMPLATE;
    state.order = layer.order ?? 50;
    state.opacity = registry.getUserLayerOpacity(layerId);
    state.userLayerIndex = layer.userLayerIndex ?? null;
  }

  function updateShaderTemplate() {
    const blendName = capitalize(state.id || 'Custom');
    const [min, max] = state.paramMeta.range;
    const samplerFn = getSamplerName(state.param);
    // Keep {userLayerIndex} placeholder - replaced when index is assigned
    state.shaderCode = SHADER_TEMPLATE
      .replace(/{BlendName}/g, blendName)
      .replace(/{paletteMin}/g, min.toFixed(1))
      .replace(/{paletteMax}/g, max.toFixed(1))
      .replace(/{samplerFn}/g, samplerFn);
  }

  /** Replace index placeholder in shader code with actual index */
  function finalizeShaderCode(index: number): string {
    return state.shaderCode.replace(/{userLayerIndex}/g, String(index));
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function validateAndCreate(registry: LayerService, aurora: AuroraService, onClose: () => void) {
    state.error = null;

    // Validate ID
    if (!state.id || !/^[a-z][a-z0-9_]*$/.test(state.id)) {
      state.error = 'ID must start with lowercase letter, contain only a-z, 0-9, _';
      m.redraw();
      return;
    }

    // Check for duplicate layer ID (built-in or user)
    const existing = registry.get(state.id);
    if (existing) {
      if (existing.isBuiltIn) {
        state.error = `Cannot use built-in layer ID "${state.id}"`;
      } else {
        state.error = `Layer "${state.id}" already exists`;
      }
      m.redraw();
      return;
    }

    // Validate shader has blend function
    const blendFn = `blend${capitalize(state.id)}`;
    if (!state.shaderCode.includes(`fn ${blendFn}`)) {
      state.error = `Shader must define function: fn ${blendFn}(...)`;
      m.redraw();
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
      m.redraw();
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
    void registry.saveUserLayer(state.id);
    onClose();
  }

  function tryLayer(registry: LayerService, aurora: AuroraService) {
    state.error = null;

    if (!state.id) {
      state.error = 'Layer ID is required';
      m.redraw();
      return;
    }

    // Validate shader has blend function
    const blendFn = `blend${capitalize(state.id)}`;
    if (!state.shaderCode.includes(`fn ${blendFn}`)) {
      state.error = `Shader must define function: fn ${blendFn}(...)`;
      m.redraw();
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

  function deleteLayer(registry: LayerService, aurora: AuroraService, onClose: () => void) {
    // Delete permanent layer if exists
    const layer = state.id ? registry.get(state.id) : null;
    if (layer && !layer.isBuiltIn) {
      registry.unregisterUserLayer(state.id);
      aurora.send({ type: 'unregisterUserLayer', layerId: state.id });
      console.log(`[CreateLayer] Deleted: ${state.id}`);
      void registry.deleteUserLayer(state.id);
    }
    suspendedLayer = null;  // Don't restore - layer was deleted
    // Also clean up preview
    cleanupPreview(registry, aurora);
    onClose();
  }

  function cleanupPreview(registry: LayerService, aurora: AuroraService) {
    if (registry.hasPreview()) {
      registry.unregisterPreview();
      aurora.send({ type: 'unregisterUserLayer', layerId: '_preview' });
      console.log('[CreateLayer] Preview cleaned up');
    }
  }

  function handleClose(registry: LayerService, aurora: AuroraService, onClose: () => void) {
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

  function resetState() {
    state.id = '';
    state.param = DEFAULT_PARAM;
    state.paramMeta = getParamMeta(DEFAULT_PARAM);
    state.order = 50;
    state.opacity = 0.5;
    state.userLayerIndex = null;
    state.error = null;
    initialized = false;
    suspendedLayer = null;
    // Generate initial shader with default param's range
    updateShaderTemplate();
  }

  let wasOpen = false;
  let windowEl: HTMLElement | null = null;

  return {
    view({ attrs }) {
      const { layerRegistry, auroraService, dialogService } = attrs;

      if (!dialogService.isOpen('create-layer')) {
        // Clean up on close
        if (wasOpen) {
          wasOpen = false;
          disposeErrorEffect?.();
          disposeErrorEffect = null;
        }
        return null;
      }

      const payload = dialogService.getPayload('create-layer');
      const editLayerId = payload?.editLayerId;
      const isEditing = !!editLayerId;

      // Initialize on open transition
      if (!wasOpen) {
        wasOpen = true;
        resetState();
        auroraService.userLayerError.value = null;

        // Generate unique ID for new layers
        if (!editLayerId) {
          const existing = new Set(layerRegistry.getUserLayers().map(l => l.id));
          let n = 1;
          while (existing.has(`layer${n}`)) n++;
          state.id = `layer${n}`;
          updateShaderTemplate();
        }

        // Watch for shader compilation errors from worker
        disposeErrorEffect = effect(() => {
          const err = auroraService.userLayerError.value;
          if (err && err.layerId === '_preview') {
            state.error = `Shader error: ${err.error}`;
            m.redraw();
          }
        });
      }

      // Initialize from existing layer on first render when editing
      if (!initialized && editLayerId) {
        initFromLayer(layerRegistry, editLayerId);
        initialized = true;
      }

      const exists = state.id && layerRegistry.get(state.id);

      const isFloating = dialogService.isFloating('create-layer');
      const isTop = dialogService.isTop('create-layer');
      const isDragging = dialogService.isDragging('create-layer');
      const dragOffset = dialogService.getDragOffset('create-layer');

      const close = () => {
        dialogService.resetDragState('create-layer');
        handleClose(layerRegistry, auroraService, () => dialogService.close('create-layer'));
      };

      const windowStyle: Record<string, string> = {};
      if (dragOffset.x !== 0 || dragOffset.y !== 0) {
        windowStyle.transform = `translate(${dragOffset.x}px, ${dragOffset.y}px)`;
      }

      const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';
      const closingClass = dialogService.isClosing('create-layer') ? 'closing' : '';

      return m('.dialog.create-layer', { class: `${floatingClass} ${closingClass}` }, [
        m('.backdrop', {
          onclick: () => {
            if (dialogService.shouldCloseOnBackdrop('create-layer')) {
              close();
            }
          }
        }),
        m('.window', {
          class: isDragging ? 'dragging' : '',
          style: windowStyle,
          onmousedown: () => dialogService.bringToFront('create-layer'),
          oncreate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
          onupdate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
        }, [
          m(DialogHeader, {
            dialogId: 'create-layer',
            title: isEditing ? 'Edit Layer' : 'Create Layer',
            dialogService,
            windowEl,
            onClose: close,
          }),

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
                  state.paramMeta = getParamMeta(state.param);
                  updateShaderTemplate();
                },
              }, DATA_PARAMS.map(p =>
                m('option', { value: p.value }, p.label)
              )),
              m('.hint', `Range: ${state.paramMeta.range[0]} – ${state.paramMeta.range[1]} ${state.paramMeta.unit}`),
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
                onclick: () => deleteLayer(layerRegistry, auroraService, close),
              }, 'Delete'),
            ]),
            m('.right', [
              m('button', { onclick: close }, 'Cancel'),
              m('button.primary', {
                disabled: !layerRegistry.hasPreview(),
                onclick: () => validateAndCreate(layerRegistry, auroraService, close),
              }, 'Save'),
            ]),
          ]),
        ]),
      ]);
    },
  };
};
