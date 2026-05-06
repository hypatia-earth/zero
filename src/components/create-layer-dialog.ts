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
import { customLayerId, buildUserLayerOptions, type LayerService, type LayerDeclaration } from '../services/layer/layer-service';
import type { AuroraService } from '../services/aurora-service';
import type { DialogService } from '../services/dialog-service';
import { defineLayer, withType, withUI, withParams, withPalettes, withBlend, withShader, withRender } from '../services/layer/builder';
import type { TCustomLayer } from '../config/types';
import { DialogHeader } from './dialog-header';
import { getParamMeta, getPublishedModelParams, getModel, type ParamMeta, type TModelParam } from '../config/models';
import { PALETTES, PALETTE_IDS, type PaletteId } from '../services/palette-service';
import { PaletteComponent } from './palette-component';
import type { ModalService } from '../services/modal-service';
import type { SlotService } from '../services/slot-service';
import 'wgsl-edit';
import projectBundle from '../aurora/shaders/layer_helpers.wesl?link';

interface CreateLayerDialogAttrs {
  layerRegistry: LayerService;
  auroraService: AuroraService;
  dialogService: DialogService;
  modalService: ModalService;
  slotService: SlotService;
}

// Params available for custom layers (all published, across all models)
const PUBLISHED_PARAMS = getPublishedModelParams();

const DEFAULT_MODEL_PARAM: TModelParam = { model: 'ecmwf_ifs', param: 'temperature_2m' };
const DEFAULT_PALETTE: PaletteId = PALETTE_IDS[0]!;

// Generate sampler function name from param (e.g., 'temperature_2m' -> 'sampleParam_temperature_2m')
function getSamplerName(param: string): string {
  const safeName = param.replace(/[^a-zA-Z0-9]/g, '_');
  return `sampleParam_${safeName}`;
}

/** Map param name to its .wesl module name under aurora/shaders/params/ */
const PARAM_MODULE_MAP: Record<string, string> = {
  cloud_cover: 'cloud_cover',
  precipitation: 'precipitation',
  snowfall_water_equivalent: 'snowfall_water_equivalent',
  pressure_msl: 'pressure_msl',
  temperature_2m: 'temperature_2m',
  wind_u_component_10m: 'wind_u_10m',
  wind_u_component_1000hPa: 'wind_u_1000hpa',
  wind_v_component_10m: 'wind_v_10m',
  wind_v_component_1000hPa: 'wind_v_1000hpa',
};

/** Params whose samplers take (lat, lon) instead of (cell: u32) — advected or GFS 0.25° */
const LATLON_SAMPLER_PARAMS = new Set([
  'precipitation',
  'snowfall_water_equivalent',
  'wind_u_component_1000hPa',
  'wind_v_component_1000hPa',
]);

/** Encode TModelParam as a single string for <select> value */
function encodeModelParam(mp: TModelParam): string {
  return `${mp.model}::${mp.param}`;
}

/** Decode <select> value back to TModelParam */
function decodeModelParam(encoded: string): TModelParam {
  const [model, param] = encoded.split('::');
  return { model, param } as TModelParam;  // QC-OK: values come from PUBLISHED_PARAMS
}

// Build DATA_PARAMS from all published model params
const DATA_PARAMS = PUBLISHED_PARAMS.map(mp => ({
  value: encodeModelParam(mp),
  label: `[${getModel(mp.model).shortName}] ${getParamMeta(mp.param).label}`,
}));

// Build palette options for combobox
const PALETTE_OPTIONS = PALETTE_IDS.map(id => ({
  value: id,
  label: PALETTES[id]!.name,
}));

// Template shaders for new layers
// {samplerFn} and {paramModule} are template-replaced when user picks a param
// LAYER_INDEX is injected as a module-scoped const by ShaderComposer

// Cell-based template: O1280 params that take (cell: u32)
const SHADER_TEMPLATE_CELL = `// Custom blend function - palette visualization
import package::aurora::shaders::params::{paramModule}::{samplerFn};
import package::aurora::shaders::layer_helpers::{getUserLayerOpacity, getUserLayerPaletteIndex, getUserLayerPaletteRange};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::palette::samplePalette;
import constants::LAYER_INDEX;

fn blend(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getUserLayerOpacity(LAYER_INDEX);
  let cell = o1280LatLonToCell(lat, lon);
  let value = {samplerFn}(cell);

  let range = getUserLayerPaletteRange(LAYER_INDEX);
  let t = clamp((value - range.x) / (range.y - range.x), 0.0, 1.0);
  let layerColor = samplePalette(t, getUserLayerPaletteIndex(LAYER_INDEX));
  return vec4f(mix(color.rgb, layerColor.rgb, opacity * layerColor.a), color.a);
}
`;

// LatLon-based template: advected/GFS params that take (lat, lon)
const SHADER_TEMPLATE_LATLON = `// Custom blend function - palette visualization
import package::aurora::shaders::params::{paramModule}::{samplerFn};
import package::aurora::shaders::layer_helpers::{getUserLayerOpacity, getUserLayerPaletteIndex, getUserLayerPaletteRange};
import package::aurora::shaders::palette::samplePalette;
import constants::LAYER_INDEX;

fn blend(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getUserLayerOpacity(LAYER_INDEX);
  let value = {samplerFn}(lat, lon);

  let range = getUserLayerPaletteRange(LAYER_INDEX);
  let t = clamp((value - range.x) / (range.y - range.x), 0.0, 1.0);
  let layerColor = samplePalette(t, getUserLayerPaletteIndex(LAYER_INDEX));
  return vec4f(mix(color.rgb, layerColor.rgb, opacity * layerColor.a), color.a);
}
`;

type TryPhase = 'idle' | 'compiling' | 'loading';

interface FormState {
  displayName: string;
  layerId: TCustomLayer | null;   // Assigned on first Try/Save (derived from index)
  modelParam: TModelParam;
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
    displayName: '',
    layerId: null,
    modelParam: DEFAULT_MODEL_PARAM,
    paramMeta: getParamMeta(DEFAULT_MODEL_PARAM.param),
    paletteId: DEFAULT_PALETTE,
    shaderCode: SHADER_TEMPLATE_CELL,
    order: 50,
    opacity: 0.5,
    userLayerIndex: null,
    tryPhase: 'idle' satisfies TryPhase,
    error: null,
  };

  let initialized = false;
  // Track layer suspended for preview (to restore on cancel)
  let suspendedLayer: LayerDeclaration | null = null;

  function initFromLayer(registry: LayerService, layerId: TCustomLayer) {
    const layer = registry.get(layerId);
    if (!layer || layer.isBuiltIn) {
      console.warn(`[CreateLayer] Layer ${layerId} not found or built-in`);
      return;
    }

    // Extract required fields - user layers must have all of these
    const paramRef = layer.params?.[0];
    const shaderCode = layer.shaders?.main;
    const order = layer.order;
    const userLayerIndex = layer.userLayerIndex;

    if (!paramRef || !shaderCode || order === undefined || userLayerIndex === undefined) {
      console.warn(`[CreateLayer] Layer ${layerId} missing required fields, using template`);
      return;
    }

    state.layerId = layerId;
    state.displayName = layer.label;
    state.modelParam = paramRef;
    state.paramMeta = getParamMeta(paramRef.param);
    state.paletteId = (layer.palettes?.[0] ?? DEFAULT_PALETTE) as PaletteId;
    state.shaderCode = shaderCode;
    state.order = order;
    state.opacity = registry.getUserLayerOpacity(layerId);
    state.userLayerIndex = userLayerIndex;
  }

  function updateShaderTemplate() {
    const samplerFn = getSamplerName(state.modelParam.param);
    const paramModule = PARAM_MODULE_MAP[state.modelParam.param] ?? state.modelParam.param;
    const template = LATLON_SAMPLER_PARAMS.has(state.modelParam.param)
      ? SHADER_TEMPLATE_LATLON
      : SHADER_TEMPLATE_CELL;

    state.shaderCode = template
      .replace(/{samplerFn}/g, samplerFn)
      .replace(/{paramModule}/g, paramModule);
  }

  function validateAndCreate(registry: LayerService, aurora: AuroraService) {
    state.error = null;

    // Validate display name
    if (!state.displayName.trim()) {
      state.error = 'Display name is required';
      m.redraw();
      return;
    }

    // Quick-save path: editing without Try — just update palette/opacity/label and persist
    if (!suspendedLayer && !registry.hasPreview() && state.layerId) {
      const layer = registry.get(state.layerId);
      if (layer && !layer.isBuiltIn) {
        layer.palettes = [state.paletteId];
        layer.label = state.displayName;
        layer.buttonLabel = state.displayName;
        registry.setUserLayerOpacity(state.layerId, state.opacity);
        console.log(`[CreateLayer] Quick-save: ${state.layerId} palette=${state.paletteId}`);
        void registry.saveUserLayer(state.layerId);
        m.redraw();
        return;
      }
    }

    // Unregister preview from worker first
    if (registry.hasPreview()) {
      aurora.send({ type: 'unregisterUserLayer', layerId: '_preview' });
    }

    // Reuse existing index when editing, allocate new one for new layers
    const index = suspendedLayer?.userLayerIndex ?? registry.allocateUserIndex();
    if (index === null) {
      state.error = `No free layer slots (max ${8})`;
      m.redraw();
      return;
    }
    const layerId = customLayerId(index);

    // Validate shader has blend function
    if (!state.shaderCode.includes('fn blend(')) {
      state.error = 'Shader must define function: fn blend(...)';
      if (!suspendedLayer) registry.freeUserIndex(index);
      m.redraw();
      return;
    }

    // Unregister preview from registry
    registry.unregisterPreview();

    // When editing, unregister old layer before re-registering with updated config
    if (suspendedLayer) {
      registry.unregister(suspendedLayer.id);
    }

    // Create and register permanent layer
    const declaration = defineLayer(layerId,
      withType('texture'),
      withUI(state.displayName, state.displayName, 'custom'),
      withParams(state.modelParam),
      withPalettes(state.paletteId),
      withBlend('blend'),
      withShader('main', state.shaderCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    const layer: LayerDeclaration = {
      ...declaration,
      userLayerIndex: index,
      isBuiltIn: false,
    };
    registry.register(layer);
    registry.setUserLayerOpacity(layerId, state.opacity);
    state.layerId = layerId;

    // Send to worker for shader recompilation
    aurora.send({ type: 'registerUserLayer', layer });
    // Enable and set initial opacity + palette + range (worker defaults to disabled)
    const paletteIndex = PALETTE_IDS.indexOf(state.paletteId);
    const [rangeMin, rangeMax] = state.paramMeta.range;
    aurora.send({ type: 'setUserLayerOptions', layerIndex: index, enabled: true, opacity: state.opacity, paletteIndex, paletteRange: [rangeMin, rangeMax] });

    console.log(`[CreateLayer] Saved: ${layerId} "${state.displayName}" (index ${index})`);
    suspendedLayer = null;  // Don't restore old layer - new one saved
    void registry.saveUserLayer(layerId);
  }

  function tryLayer(registry: LayerService, aurora: AuroraService) {
    state.error = null;
    state.tryPhase = 'compiling';
    aurora.userLayerState.value = null;  // Reset so signal fires on next ok/error

    if (!state.displayName.trim()) {
      state.error = 'Display name is required';
      state.tryPhase = 'idle';
      m.redraw();
      return;
    }

    // If editing existing layer, unregister it from worker to avoid duplicate blend function
    if (state.layerId) {
      const existingLayer = registry.get(state.layerId);
      if (existingLayer && !existingLayer.isBuiltIn) {
        suspendedLayer = existingLayer;  // Save for restore on cancel
        aurora.send({ type: 'unregisterUserLayer', layerId: state.layerId });
      }
    }

    // Validate shader has blend function
    if (!state.shaderCode.includes('fn blend(')) {
      state.error = 'Shader must define function: fn blend(...)';
      state.tryPhase = 'idle';
      m.redraw();
      return;
    }

    // Preview uses slot 8 — ShaderComposer wraps it as user_layer_preview module
    const previewIndex = 8;

    // Create preview layer declaration (shader code used as-is, no string replacement)
    const declaration = defineLayer('_preview',
      withType('texture'),
      withUI('Preview', 'Preview', 'custom'),
      withParams(state.modelParam),
      withBlend('blend'),
      withShader('main', state.shaderCode),
      withRender({ pass: 'surface', order: state.order }),
    );

    // Register as preview (replaces any existing preview)
    const layer = registry.registerPreview(declaration);

    // Send to worker for shader recompilation
    aurora.send({ type: 'registerUserLayer', layer });
    // Enable and set opacity + palette + range (worker defaults to disabled)
    const paletteIndex = PALETTE_IDS.indexOf(state.paletteId);
    const [rangeMin, rangeMax] = state.paramMeta.range;
    aurora.send({ type: 'setUserLayerOptions', layerIndex: previewIndex, enabled: true, opacity: state.opacity, paletteIndex, paletteRange: [rangeMin, rangeMax] });

    console.log(`[CreateLayer] Preview: "${state.displayName}" param=${state.modelParam.model}/${state.modelParam.param} palette=${state.paletteId} (index ${previewIndex})`);
    m.redraw();  // Update UI (enables Save button)
  }

  async function deleteLayer(registry: LayerService, aurora: AuroraService, modalService: ModalService, onClose: () => void) {
    if (!state.layerId) return;
    const confirmed = await modalService.confirmDelete(state.displayName || state.layerId);
    if (!confirmed) return;

    // Delete permanent layer if exists
    const layer = registry.get(state.layerId);
    if (layer && !layer.isBuiltIn) {
      registry.unregisterUserLayer(state.layerId);
      aurora.send({ type: 'unregisterUserLayer', layerId: state.layerId });
      console.log(`[CreateLayer] Deleted: ${state.layerId}`);
      void registry.deleteUserLayer(state.layerId);
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
      // Restore options (enabled, palette, range)
      if (suspendedLayer.userLayerIndex !== undefined) {
        const enabled = registry.isLayerEnabled(suspendedLayer.id);
        aurora.send(buildUserLayerOptions(suspendedLayer, enabled));
      }
      console.log(`[CreateLayer] Restored: ${suspendedLayer.id}`);
      suspendedLayer = null;
    }
    onClose();
  }

  let disposeErrorEffect: (() => void) | null = null;

  function resetState() {
    state.displayName = '';
    state.layerId = null;
    state.modelParam = DEFAULT_MODEL_PARAM;
    state.paramMeta = getParamMeta(DEFAULT_MODEL_PARAM.param);
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
      const editLayerId = payload?.editLayerId as TCustomLayer | undefined;
      const isEditing = !!editLayerId;

      // Initialize on open transition
      if (!wasOpen) {
        wasOpen = true;
        resetState();
        auroraService.userLayerState.value = null;

        // Auto-generate display name for new layers
        if (!editLayerId) {
          const existingNames = new Set(
            layerRegistry.getAll().filter(l => !l.isBuiltIn).map(l => l.label)
          );
          let n = 1;
          while (existingNames.has(`Custom ${n}`)) n++;
          state.displayName = `Custom ${n}`;
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

          if (state.tryPhase === 'loading' && attrs.slotService.isParamReady(state.modelParam.param)) {
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

      const exists = state.layerId && layerRegistry.get(state.layerId);

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
            // Display Name
            m('.field', [
              m('label', 'Display Name'),
              m('input[type=text]', {
                'data-testid': 'layer-name-input',
                placeholder: 'e.g., My Temperature',
                value: state.displayName,
                oninput: (e: Event) => {
                  state.displayName = (e.target as HTMLInputElement).value;
                },
              }),
              m('.hint', 'Name shown in the layer panel'),
            ]),

            // Data parameter + Palette (side by side)
            m('.field-row', [
              m('.field', [
                m('label', 'Data Parameter'),
                m('select', {
                  'data-testid': 'layer-param-select',
                  value: encodeModelParam(state.modelParam),
                  onchange: (e: Event) => {
                    state.modelParam = decodeModelParam((e.target as HTMLSelectElement).value);
                    state.paramMeta = getParamMeta(state.modelParam.param);
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
                    const index = isEditing && editLayerId ? layerRegistry.get(editLayerId)?.userLayerIndex : 8;
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
              palette: PALETTES[state.paletteId],
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
                    const index = isEditing && editLayerId ? layerRegistry.get(editLayerId)?.userLayerIndex : 8;
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
              m('label', 'Blend Shader (WGSL/WESL)'),
              m('wgsl-edit', {
                'data-testid': 'layer-shader-textarea',
                theme: 'dark',
                lint: 'on',
                tabs: false,
                oncreate: (vnode: m.VnodeDOM) => {
                  const el = vnode.dom as HTMLElement & { source: string; project: Record<string, unknown> };
                  // Set libs for WESL linting context, then source (registers in _files as of wgsl-edit 0.0.14)
                  el.project = {
                    libs: [{
                      name: projectBundle.packageName ?? 'package',
                      edition: '2026_pre',
                      modules: projectBundle.weslSrc ?? {},
                    }],
                  };
                  el.source = state.shaderCode;
                  // Fix Shadow DOM layout: constrain editor-container height for CM6 scrolling
                  // and replace position:sticky gutters to suppress Firefox scroll-linked warning
                  if (el.shadowRoot) {
                    const fix = document.createElement('style');
                    fix.textContent = '.editor-container { height: calc(100% - 31px); overflow: hidden; } .cm-gutters { position: relative !important; }';
                    el.shadowRoot.appendChild(fix);
                  }
                  el.addEventListener('change', (e: Event) => {
                    const detail = (e as CustomEvent).detail;
                    if (detail?.source !== undefined) {
                      state.shaderCode = detail.source;
                      state.error = null;
                    }
                  });
                },
                onupdate: (vnode: m.VnodeDOM) => {
                  const el = vnode.dom as HTMLElement & { source: string };
                  if (el.source !== state.shaderCode) {
                    el.source = state.shaderCode;
                  }
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
