/**
 * OptionsPanel - Gear icon to open options dialog
 */

import m from 'mithril';
import type { DialogService } from '../services/dialog-service';
import { GearIcon } from './gear-icon';

interface OptionsPanelAttrs {
  dialogService: DialogService;
}

export const OptionsPanel: m.ClosureComponent<OptionsPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { dialogService } = attrs;
      return m('.panel.options', [
        m('button.control.circle', {
          onclick: () => dialogService.open('options', {}),
          title: 'Options'
        }, m(GearIcon))
      ]);
    },
  };
};
