/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
import type { ConfigService } from '../services/config-service';
import type { OptionsService } from '../services/options-service';
import { LAYER_CATEGORIES, LAYER_CATEGORY_LABELS, type TLayer } from '../config/types';

interface LayersPanelAttrs {
  configService: ConfigService;
  optionsService: OptionsService;
  onCreateLayer?: () => void;
}

export const LayersPanel: m.ClosureComponent<LayersPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { configService, optionsService, onCreateLayer } = attrs;
      const readyLayerIds = new Set(configService.getReadyLayers());
      const layers = configService.getLayers().filter(l => readyLayerIds.has(l.id));
      const opts = optionsService.options.value;

      return m('.panel.layers', [
        LAYER_CATEGORIES.map(category => {
          const categoryLayers = layers.filter(l => l.category === category);
          if (categoryLayers.length === 0) return null;

          return m('.group', { key: category }, [
            m('h4', LAYER_CATEGORY_LABELS[category]),
            categoryLayers.map(layer =>
              m(LayerWidget, {
                key: layer.id,
                layer,
                active: opts[layer.id].enabled,
                onToggle: () => optionsService.update(draft => { draft[layer.id].enabled = !draft[layer.id].enabled; }),
                onOptions: () => optionsService.openDialog(layer.id),
              })
            ),
          ]);
        }),
        // Add layer button
        onCreateLayer && m('.group', [
          m('button.add-layer', {
            onclick: onCreateLayer,
            title: 'Create custom layer',
          }, '+ Add Layer'),
        ]),
      ]);
    },
  };
};

interface LayerWidgetAttrs {
  layer: { id: TLayer; label: string; buttonLabel: string };
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
