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
import { defineLayer, withType, withUI, withParams, withPalettes, withOptions, withBlend, withShader, withRender } from '../services/layer/builder';
import { DialogHeader } from './dialog-header';
import { PARAM_METADATA, getParamMeta, getPublishedParams, type ParamMeta } from '../config/params-ecmwf_ifs';
import { PALETTES, PALETTE_IDS, type PaletteId } from '../services/palette-service';
import { PaletteComponent } from './palette-component';
import type { PaletteData, LabelMode } from '../services/palette-service';
import type { ModalService } from '../services/modal-service';
import type { SlotService } from '../services/slot-service';

interface CreateLayerDialogAttrs {
  layerRegistry: LayerService;
  auroraService: AuroraService;
  dialogService: DialogService;
  modalService: ModalService;
  slotService: SlotService;
}

// Params available for custom layers (from metadata)
const ALLOWED_PARAMS = getPublishedParams();

const DEFAULT_PARAM = 'temperature_2m' satisfies keyof typeof PARAM_METADATA;
const DEFAULT_PALETTE: PaletteId = PALETTE_IDS[0] as PaletteId;  // temp-classic

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

// Build palette options for combobox
const PALETTE_OPTIONS = PALETTE_IDS.map(id => ({
  value: id,
  label: PALETTES[id]!.name,
}));

/** Convert registry palette to PaletteData for PaletteComponent */
function toPaletteData(id: PaletteId): PaletteData {
  const p = PALETTES[id]!;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    interpolate: p.interpolate,
    labelMode: (p.interpolate ? 'value-centered' : 'band-edge') as LabelMode,
    stops: p.stops,
  };
}

// Template shader for new layers
// Placeholders: {BlendName}, {userLayerIndex}, {paletteMin}, {paletteMax}, {samplerFn}
const SHADER_TEMPLATE = `// Custom blend function - palette visualization
fn blend{BlendName}(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getUserLayerOpacity({userLayerIndex}u);
  let cell = o1280LatLonToCell(lat, lon);
  let value = {samplerFn}(cell);

  let t = clamp((value - {paletteMin}) / ({paletteMax} - {paletteMin}), 0.0, 1.0);
  let layerColor = samplePalette(t, getUserLayerPaletteIndex({userLayerIndex}u));
  return vec4f(mix(color.rgb, layerColor.rgb, opacity * layerColor.a), color.a);
}
`;

type TryPhase = 'idle' | 'compiling' | 'loading';

interface FormState {
  id: string;
  param: string;
  paramMeta: ParamMeta;
  paletteId: PaletteId;
  shaderCode: string;
  order: number;
  opacity: number;
  userLayerIndex: number | null;  // Assigned on first Try/Save
  tryPhase: TryPhase;             // idle → compiling → loading → idle
  error: string | null;
}

export const CreateLayerDialog: m.ClosureComponent<CreateLayerDialogAttrs> = () => {
  const state: FormState = {
    id: '',
    param: DEFAULT_PARAM,
    paramMeta: getParamMeta(DEFAULT_PARAM),
    paletteId: DEFAULT_PALETTE,
    shaderCode: SHADER_TEMPLATE,
    order: 50,
    opacity: 0.5,
    userLayerIndex: null,
    tryPhase: 'idle' as TryPhase,
    error: null,
  };

  let initialized = false;
  // Track layer suspended for preview (to restore on cancel)
  let suspendedLayer: LayerDeclaration | null = null;

  function initFromLayer(registry: LayerService, layerId: string) {
    const layer = registry.get(layerId);
    if (!layer || layer.isBuiltIn) {
      console.warn(`[CreateLayer] Layer ${layerId} not found or built-in`);
      return;
    }

    // Extract required fields - user layers must have all of these
    const param = layer.params?.[0];
    const shaderCode = layer.shaders?.main;
    const order = layer.order;
    const userLayerIndex = layer.userLayerIndex;

    if (!param || !shaderCode || order === undefined || userLayerIndex === undefined) {
      console.warn(`[CreateLayer] Layer ${layerId} missing required fields, using template`);
      return;
    }

    state.id = layer.id;
    state.param = param;
    state.paramMeta = getParamMeta(param);
    state.paletteId = (layer.palettes?.[0] ?? DEFAULT_PALETTE) as PaletteId;
    state.shaderCode = shaderCode;
    state.order = order;
    state.opacity = registry.getUserLayerOpacity(layerId);
    state.userLayerIndex = userLayerIndex;
  }

  function updateShaderTemplate() {
    const blendName = capitalize(state.id || 'Custom');
    const [min, max] = state.paramMeta.range;
    const samplerFn = getSamplerName(state.param);

    // Keep {userLayerIndex} placeholder - replaced when index is assigned
    // Palette index is set via uniform, not baked into shader
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

  function validateAndCreate(registry: LayerService, aurora: AuroraService) {
    state.error = null;

    // Quick-save path: editing without Try — just update palette/opacity and persist
    if (!suspendedLayer && !registry.hasPreview()) {
      const layer = registry.get(state.id);
      if (layer && !layer.isBuiltIn) {
        layer.palettes = [state.paletteId];
        registry.setUserLayerOpacity(state.id, state.opacity);
        console.log(`[CreateLayer] Quick-save: ${state.id} palette=${state.paletteId}`);
        void registry.saveUserLayer(state.id);
        m.redraw();
        return;
      }
    }

    // Validate ID
    if (!state.id || !/^[a-z][a-z0-9_]*$/.test(state.id)) {
      state.error = 'ID must start with lowercase letter, contain only a-z, 0-9, _';
      m.redraw();
      return;
    }

    // Check for duplicate layer ID (built-in or user) — skip if editing this layer
    const existing = registry.get(state.id);
    if (existing && existing !== suspendedLayer) {
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

    // Reuse existing index when editing, allocate new one for new layers
    const index = suspendedLayer?.userLayerIndex ?? registry.allocateUserIndex();
    if (index === null) {
      state.error = 'No free layer slots (max 31 user layers)';
      m.redraw();
      return;
    }

    // Finalize shader code with permanent index
    const finalizedCode = finalizeShaderCode(index);

    // Unregister preview from registry
    registry.unregisterPreview();

    // When editing, unregister old layer before re-registering with updated config
    if (suspendedLayer) {
      registry.unregister(state.id);
    }

    // Create and register permanent layer
    const declaration = defineLayer(state.id,
      withType('texture'),
      withUI(state.id, state.id, 'custom'),
      withParams([state.param]),
      withPalettes(state.paletteId),
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
    // Enable and set initial opacity + palette (worker defaults to disabled)
    const paletteIndex = PALETTE_IDS.indexOf(state.paletteId);
    aurora.send({ type: 'setUserLayerOptions', layerIndex: index, enabled: true, opacity: state.opacity, paletteIndex });

    console.log(`[CreateLayer] Saved: ${state.id} (index ${index})`);
    suspendedLayer = null;  // Don't restore old layer - new one saved
    void registry.saveUserLayer(state.id);
  }

  function tryLayer(registry: LayerService, aurora: AuroraService) {
    state.error = null;
    state.tryPhase = 'compiling';
    aurora.userLayerState.value = null;  // Reset so signal fires on next ok/error

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
      withUI('_preview', '_preview', 'custom'),
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
    // Enable and set opacity + palette (worker defaults to disabled)
    const paletteIndex = PALETTE_IDS.indexOf(state.paletteId);
    aurora.send({ type: 'setUserLayerOptions', layerIndex: 31, enabled: true, opacity: state.opacity, paletteIndex });

    console.log(`[CreateLayer] Preview: ${state.id} param=${state.param} palette=${state.paletteId} (index 31)`);
    m.redraw();  // Update UI (enables Save button)
  }

  async function deleteLayer(registry: LayerService, aurora: AuroraService, modalService: ModalService, onClose: () => void) {
    const confirmed = await modalService.confirmDelete(state.id);
    if (!confirmed) return;

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
    state.paletteId = DEFAULT_PALETTE;
    state.order = 50;
    state.opacity = 0.5;
    state.userLayerIndex = null;
    state.tryPhase = 'idle';
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
      const { layerRegistry, auroraService, dialogService, modalService } = attrs;

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
        auroraService.userLayerState.value = null;

        // Generate unique ID for new layers
        if (!editLayerId) {
          const existing = new Set(layerRegistry.getAll().filter(l => !l.isBuiltIn).map(l => l.id));
          let n = 1;
          while (existing.has(`layer${n}`)) n++;
          state.id = `layer${n}`;
          updateShaderTemplate();
        }

        // Watch for shader compilation result + data readiness
        disposeErrorEffect = effect(() => {
          const result = auroraService.userLayerState.value;
          void attrs.slotService.slotsVersion.value;  // Subscribe to slot changes

          if (state.tryPhase === 'compiling' && result !== null) {
            if (result === 'ok') {
              state.tryPhase = 'loading';
            } else if (result.layerId === '_preview') {
              state.error = `Shader error: ${result.error}`;
              state.tryPhase = 'idle';
            }
            m.redraw();
          }

          if (state.tryPhase === 'loading' && attrs.slotService.isParamReady(state.param)) {
            state.tryPhase = 'idle';
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

          // Content (fieldset disables all inputs while shader compiles)
          m('fieldset.content', { disabled: state.tryPhase !== 'idle' }, [
            // Layer ID
            m('.field', [
              m('label', 'Layer ID'),
              m('input[type=text]', {
                'data-testid': 'layer-id-input',
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

            // Data parameter + Palette (side by side)
            m('.field-row', [
              m('.field', [
                m('label', 'Data Parameter'),
                m('select', {
                  'data-testid': 'layer-param-select',
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
              m('.field', [
                m('label', 'Palette'),
                m('select', {
                  'data-testid': 'layer-palette-select',
                  value: state.paletteId,
                  onchange: (e: Event) => {
                    state.paletteId = (e.target as HTMLSelectElement).value as PaletteId;
                    // Live palette switching via uniform (no shader recompilation needed)
                    const index = isEditing ? layerRegistry.get(editLayerId!)?.userLayerIndex : 31;
                    if (index !== undefined && (layerRegistry.hasPreview() || isEditing)) {
                      const paletteIndex = PALETTE_IDS.indexOf(state.paletteId);
                      auroraService.send({ type: 'setUserLayerOptions', layerIndex: index, paletteIndex });
                    }
                  },
                }, PALETTE_OPTIONS.map(p =>
                  m('option', { value: p.value }, p.label)
                )),
              ]),
            ]),
            m(PaletteComponent, {
              palette: toPaletteData(state.paletteId),
              height: 30,
              fontSize: 10,
              color: '#888888',
            }),

            // Opacity + Render order (side by side)
            m('.field-row', [
              m('.field.opacity', [
                m('label', `Opacity: ${Math.round(state.opacity * 100)}%`),
                m('input[type=range]', {
                  'data-testid': 'layer-opacity-slider',
                  min: 0,
                  max: 100,
                  value: state.opacity * 100,
                  disabled: !layerRegistry.hasPreview() && !isEditing,
                  oninput: (e: Event) => {
                    state.opacity = parseInt((e.target as HTMLInputElement).value) / 100;
                    // Send to worker in real-time
                    const index = isEditing ? layerRegistry.get(editLayerId!)?.userLayerIndex : 31;
                    if (index !== undefined) {
                      auroraService.send({ type: 'setUserLayerOptions', layerIndex: index, opacity: state.opacity });
                    }
                  },
                }),
              ]),
              m('.field.order', [
                m('label', 'Render Order'),
                m('input[type=number]', {
                  'data-testid': 'layer-order-input',
                  min: 0,
                  max: 100,
                  value: state.order,
                  oninput: (e: Event) => {
                    state.order = parseInt((e.target as HTMLInputElement).value) || 50;
                  },
                }),
                m('.hint', 'earth=0, temp=10'),
              ]),
            ]),

            // Shader code
            m('.field.shader', [
              m('label', 'Blend Shader (WGSL)'),
              m('textarea', {
                'data-testid': 'layer-shader-textarea',
                value: state.shaderCode,
                oninput: (e: Event) => {
                  state.shaderCode = (e.target as HTMLTextAreaElement).value;
                  state.error = null;
                },
              }),
            ]),

            // Error message
            state.error && m('.error', {
              'data-testid': 'layer-error',
              oncreate: (vnode: m.VnodeDOM) => (vnode.dom as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
            }, state.error),
          ]),

          // Footer
          m('.footer', [
            m('.left', [
              m('button', {
                'data-testid': 'layer-try-btn',
                disabled: state.tryPhase !== 'idle',
                onclick: () => tryLayer(layerRegistry, auroraService),
              }, state.tryPhase === 'compiling' ? 'Compiling…' : state.tryPhase === 'loading' ? 'Loading…' : 'Try'),
              exists && m('button.danger', {
                'data-testid': 'layer-delete-btn',
                disabled: state.tryPhase !== 'idle',
                onclick: () => deleteLayer(layerRegistry, auroraService, modalService, close),
              }, 'Delete'),
            ]),
            m('.right', [
              m('button.primary', {
                'data-testid': 'layer-save-btn',
                disabled: state.tryPhase !== 'idle' || (!isEditing && !layerRegistry.hasPreview()),
                onclick: () => validateAndCreate(layerRegistry, auroraService),
              }, 'Save'),
              m('button.btn.btn-secondary', { 'data-testid': 'layer-close-btn', onclick: close }, 'Close'),
            ]),
          ]),
        ]),
      ]);
    },
  };
};
