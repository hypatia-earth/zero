/**
 * RadioPaletteControl - Radio button group with visual palette previews
 *
 * Shows available palettes with visual previews using PaletteComponent
 */

import m from 'mithril';
import { PaletteComponent } from './palette-component';
import type { PaletteData } from '../services/palette-service';

export interface RadioPaletteControlAttrs {
  palettes: PaletteData[];
  selected: string;
  onSelect: (paletteName: string) => void;
}

export const RadioPaletteControl: m.ClosureComponent<RadioPaletteControlAttrs> = () => {
  return {
    view({ attrs }) {
      const { palettes, selected, onSelect } = attrs;

      if (palettes.length === 0) {
        return m('div.radio-palette-control', [
          m('p.hint', 'No palettes available')
        ]);
      }

      return m('div.radio-palette-control', [
        palettes.map(palette =>
          m('label.palette-option', {
            key: palette.name,
            class: selected === palette.name ? 'selected' : '',
            onclick: () => onSelect(palette.name)
          }, [
            m('input[type=radio]', {
              name: 'palette-selection',
              value: palette.name,
              checked: selected === palette.name,
              onchange: () => onSelect(palette.name)
            }),
            m('div.palette-preview', [
              m('div.palette-name', palette.name),
              m(PaletteComponent, {
                palette,
                width: 200,
                height: 30,
                fontSize: 10,
                color: '#888888'
              }),
              palette.description ? m('div.palette-description', palette.description) : null
            ])
          ])
        )
      ]);
    }
  };
};
