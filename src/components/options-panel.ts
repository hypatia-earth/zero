/**
 * OptionsPanel - Gear icon to open options dialog
 */

import m from 'mithril';
import type { OptionsService } from '../services/options-service';
import { GearIcon } from './GearIcon';

interface OptionsPanelAttrs {
  optionsService: OptionsService;
}

export const OptionsPanel: m.ClosureComponent<OptionsPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { optionsService } = attrs;
      return m('.panel.options', [
        m('button.control.circle', {
          onclick: () => optionsService.openDialog(),
          title: 'Options'
        }, m(GearIcon))
      ]);
    },
  };
};
