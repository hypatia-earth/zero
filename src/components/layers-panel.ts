/**
 * LayersPanel - Layer toggle buttons
 */

import m from 'mithril';
import { GearIcon } from './gear-icon';
import type { ConfigService } from '../services/config-service';
import type { OptionsService } from '../services/options-service';
import type { LayerId } from '../config/types';
import type { OptionFilter } from '../schemas/options.schema';

/** Layers that have configurable options */
const LAYERS_WITH_OPTIONS: LayerId[] = ['earth', 'sun', 'grid', 'temp', 'rain'];

interface LayersPanelAttrs {
  configService: ConfigService;
  optionsService: OptionsService;
}

export const LayersPanel: m.ClosureComponent<LayersPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { configService, optionsService } = attrs;
      const layers = configService.getLayers();
      const opts = optionsService.options.value;

      const isEnabled = (layerId: string): boolean => {
        switch (layerId) {
          case 'earth': return opts.earth.enabled;
          case 'sun': return opts.sun.enabled;
          case 'grid': return opts.grid.enabled;
          case 'temp': return opts.temp.enabled;
          case 'rain': return opts.rain.enabled;
          case 'clouds': return opts.clouds.enabled;
          case 'humidity': return opts.humidity.enabled;
          case 'wind': return opts.wind.enabled;
          case 'pressure': return opts.pressure.enabled;
          default: return false;
        }
      };

      const toggleLayer = (layerId: string) => {
        optionsService.update(draft => {
          switch (layerId) {
            case 'earth': draft.earth.enabled = !draft.earth.enabled; break;
            case 'sun': draft.sun.enabled = !draft.sun.enabled; break;
            case 'grid': draft.grid.enabled = !draft.grid.enabled; break;
            case 'temp': draft.temp.enabled = !draft.temp.enabled; break;
            case 'rain': draft.rain.enabled = !draft.rain.enabled; break;
            case 'clouds': draft.clouds.enabled = !draft.clouds.enabled; break;
            case 'humidity': draft.humidity.enabled = !draft.humidity.enabled; break;
            case 'wind': draft.wind.enabled = !draft.wind.enabled; break;
            case 'pressure': draft.pressure.enabled = !draft.pressure.enabled; break;
          }
        });
      };

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
                active: isEnabled(layer.id),
                hasOptions,
                onToggle: () => toggleLayer(layer.id),
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
