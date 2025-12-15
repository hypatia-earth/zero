/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import type { ConfigService } from '../services/config-service';
import type { StateService } from '../services/state-service';
import type { OptionsService } from '../services/options-service';
import type { LayerId } from '../config/types';

interface LayersPanelAttrs {
  configService: ConfigService;
  stateService: StateService;
  optionsService: OptionsService;
}

export const LayersPanel: m.ClosureComponent<LayersPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { configService, stateService } = attrs;
      const layers = configService.getLayers();
      const activeLayers = stateService.getLayers();

      const categories = ['base', 'weather', 'overlay'] as const;
      const categoryLabels = { base: 'Base', weather: 'Weather', overlay: 'Overlays' };

      return m('.panel.layers', [
        categories.map(category => {
          const categoryLayers = layers.filter(l => l.category === category);
          if (categoryLayers.length === 0) return null;

          return m('.group', { key: category }, [
            m('h4', categoryLabels[category]),
            categoryLayers.map(layer =>
              m(LayerWidget, {
                key: layer.id,
                layer,
                active: activeLayers.includes(layer.id),
                onToggle: () => stateService.toggleLayer(layer.id),
              })
            ),
          ]);
        }),
      ]);
    },
  };
};

interface LayerWidgetAttrs {
  layer: { id: LayerId; label: string };
  active: boolean;
  onToggle: () => void;
}

const LayerWidget: m.ClosureComponent<LayerWidgetAttrs> = () => {
  return {
    view({ attrs }) {
      const { layer, active, onToggle } = attrs;
      const classes = ['layer', 'widget', 'bar'];
      if (active) classes.push('active', layer.id);

      return m('div', { class: classes.join(' ') }, [
        m('button.toggle', { onclick: onToggle }, layer.label),
      ]);
    },
  };
};
