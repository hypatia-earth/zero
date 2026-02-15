/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
import type { ConfigService } from '../services/config-service';
import type { OptionsService } from '../services/options-service';
import type { LayerService } from '../services/layer/layer-service';
import type { AuroraService } from '../services/aurora-service';
import type { DialogService } from '../services/dialog-service';
import { LAYER_CATEGORIES, LAYER_CATEGORY_LABELS, type TLayer } from '../config/types';

interface LayersPanelAttrs {
  configService: ConfigService;
  optionsService: OptionsService;
  layerRegistry: LayerService;
  auroraService: AuroraService;
  dialogService: DialogService;
}

export const LayersPanel: m.ClosureComponent<LayersPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { configService, optionsService, layerRegistry, auroraService, dialogService } = attrs;
      const readyLayerIds = new Set<string>(configService.getReadyLayers());
      const layers = layerRegistry.getAll().filter(l => l.isBuiltIn && readyLayerIds.has(l.id));
      const opts = optionsService.options.value;

      // Get user layers from registry (exclude preview)
      const userLayers = layerRegistry.getAll().filter(l => !l.isBuiltIn && l.id !== '_preview');

      // Build groups array without holes
      const groups: m.Vnode[] = [];

      // Built-in categories (celestial, weather, reference)
      for (const category of LAYER_CATEGORIES) {
        if (category === 'custom') continue;
        const categoryLayers = layers.filter(l => l.category === category);
        if (categoryLayers.length === 0) continue;

        groups.push(m('.group', { key: category }, [
          m('h4', LAYER_CATEGORY_LABELS[category]),
          categoryLayers.map(layer => {
            const id = layer.id as TLayer;
            return m(LayerWidget, {
              key: id,
              layer,
              active: opts[id].enabled,
              onToggle: () => optionsService.update(draft => { draft[id].enabled = !draft[id].enabled; }),
              onOptions: () => dialogService.open('options', { filter: id }),
            });
          }
          ),
        ]));
      }

      // Custom category: user layers from registry
      if (userLayers.length > 0) {
        groups.push(m('.group', { key: 'custom' }, [
          m('h4', LAYER_CATEGORY_LABELS.custom),
          userLayers.map(layer =>
            m(LayerWidget, {
              key: layer.id,
              layer: { id: layer.id as TLayer, label: layer.id, buttonLabel: layer.id },
              active: layerRegistry.isLayerEnabled(layer.id),
              onToggle: () => {
                const enabled = layerRegistry.toggleUserLayer(layer.id);
                if (layer.userLayerIndex !== undefined) {
                  auroraService.send({ type: 'setUserLayerEnabled', layerIndex: layer.userLayerIndex, enabled });
                }
                m.redraw();
              },
              onOptions: () => dialogService.open('create-layer', { editLayerId: layer.id }),
            })
          ),
        ]));
      }

      // Add layer button
      groups.push(m('.group', { key: 'add-layer' }, [
        m('button.add-layer', {
          onclick: () => dialogService.open('create-layer', {}),
          title: 'Create custom layer',
        }, '+ Add Layer'),
      ]));

      return m('.panel.layers', groups);
    },
  };
};

interface LayerWidgetAttrs {
  layer: { id: string; label?: string; buttonLabel?: string };
  active: boolean;
  onToggle: () => void;
  onOptions: () => void;
}

const LayerWidget: m.ClosureComponent<LayerWidgetAttrs> = () => {
  return {
    view({ attrs }) {
      const { layer, active, onToggle, onOptions } = attrs;
      const classes = ['layer', 'widget', 'bar'];
      if (active) classes.push('active', layer.id);

      return m('div', { class: classes.join(' ') }, [
        m('button.toggle', { onclick: onToggle }, layer.buttonLabel),
        m('button.options', {
          title: `${layer.label} options`,
          onclick: (e: Event) => {
            e.stopPropagation();
            onOptions();
          }
        }, m(GearIcon)),
      ]);
    },
  };
};
