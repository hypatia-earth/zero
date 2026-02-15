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

      // All displayable layers: built-in (if ready) + custom (exclude preview)
      const allLayers = layerRegistry.getAll().filter(l =>
        l.isBuiltIn ? readyLayerIds.has(l.id) : l.id !== '_preview'
      );

      // Toggle handler for any layer
      const toggleLayer = (layer: typeof allLayers[0]) => {
        if (layer.isBuiltIn) {
          const id = layer.id as TLayer;
          optionsService.update(draft => { draft[id].enabled = !draft[id].enabled; });
        } else {
          const enabled = layerRegistry.toggleUserLayer(layer.id);
          if (layer.userLayerIndex !== undefined) {
            auroraService.send({ type: 'setUserLayerEnabled', layerIndex: layer.userLayerIndex, enabled });
          }
          m.redraw();
        }
      };

      // Options handler for any layer
      const openOptions = (layer: typeof allLayers[0]) => {
        if (layer.isBuiltIn) {
          dialogService.open('options', { filter: layer.id as TLayer });
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
