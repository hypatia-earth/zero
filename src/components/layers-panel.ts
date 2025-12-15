/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
import type { ConfigService } from '../services/config-service';
import type { StateService } from '../services/state-service';
import type { OptionsService } from '../services/options-service';
import type { LayerId } from '../config/types';
import type { OptionFilter } from '../schemas/options.schema';

/** Layers that have configurable options */
const LAYERS_WITH_OPTIONS: LayerId[] = ['earth', 'sun', 'grid', 'temp', 'rain'];

interface LayersPanelAttrs {
  configService: ConfigService;
  stateService: StateService;
  optionsService: OptionsService;
}

export const LayersPanel: m.ClosureComponent<LayersPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { configService, stateService, optionsService } = attrs;
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
            categoryLayers.map(layer => {
              const hasOptions = LAYERS_WITH_OPTIONS.includes(layer.id);
              return m(LayerWidget, {
                key: layer.id,
                layer,
                active: activeLayers.includes(layer.id),
                hasOptions,
                onToggle: () => stateService.toggleLayer(layer.id),
                onOptions: () => hasOptions && optionsService.openDialog(layer.id as OptionFilter),
              });
            }),
          ]);
        }),
      ]);
    },
  };
};

interface LayerWidgetAttrs {
  layer: { id: LayerId; label: string };
  active: boolean;
  hasOptions: boolean;
  onToggle: () => void;
  onOptions: () => void;
}

const LayerWidget: m.ClosureComponent<LayerWidgetAttrs> = () => {
  return {
    view({ attrs }) {
      const { layer, active, hasOptions, onToggle, onOptions } = attrs;
      const classes = ['layer', 'widget', 'bar'];
      if (active) classes.push('active', layer.id);

      return m('div', { class: classes.join(' ') }, [
        m('button.toggle', { onclick: onToggle }, layer.label),
        hasOptions ? m('button.options', {
          title: `${layer.label} options`,
          onclick: (e: Event) => {
            e.stopPropagation();
            onOptions();
          }
        }, m(GearIcon)) : null,
      ]);
    },
  };
};
