/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
import type { ConfigService } from '../services/config-service';
import type { OptionsService } from '../services/options-service';
import { isBuiltInLayer, type LayerService } from '../services/layer/layer-service';
import type { AuroraService } from '../services/aurora-service';
import type { DialogService } from '../services/dialog-service';
import { LAYER_CATEGORIES, LAYER_CATEGORY_LABELS } from '../config/types';

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
      const { optionsService, layerRegistry, auroraService, dialogService } = attrs;

      // All displayable layers: built-in + custom (exclude preview)
      const allLayers = layerRegistry.getAll().filter(l => l.id !== '_preview');

      // Toggle handler for any layer
      const toggleLayer = (layer: typeof allLayers[0]) => {
        if (isBuiltInLayer(layer)) {
          optionsService.update(draft => { draft[layer.id].enabled = !draft[layer.id].enabled; });
        } else {
          const enabled = layerRegistry.toggleUserLayer(layer.id);
          if (layer.userLayerIndex !== undefined) {
            auroraService.send({ type: 'setUserLayerOptions', layerIndex: layer.userLayerIndex, enabled });
          }
          m.redraw();
        }
      };

      // Options handler for any layer
      const openOptions = (layer: typeof allLayers[0]) => {
        if (isBuiltInLayer(layer)) {
          dialogService.open('options', { filter: layer.id });
        } else {
          dialogService.open('create-layer', { editLayerId: layer.id });
        }
      };

      // Build groups by category
      const groups: m.Vnode[] = [];
      for (const category of LAYER_CATEGORIES) {
        const categoryLayers = allLayers.filter(l => l.category === category);
        if (categoryLayers.length === 0) continue;

        groups.push(m('.group', { key: category }, [
          m('h4', LAYER_CATEGORY_LABELS[category]),
          categoryLayers.map(layer =>
            m(LayerWidget, {
              key: layer.id,
              layer,
              active: layerRegistry.isLayerEnabled(layer.id),
              onToggle: () => toggleLayer(layer),
              onOptions: () => openOptions(layer),
            })
          ),
        ]));
      }

      // Add layer button
      groups.push(m('.group', { key: 'add-layer' }, [
        m('button.add-layer.desktop-only', {
          'data-testid': 'add-layer-btn',
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
