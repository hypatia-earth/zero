/**
 * OptionsPanel - Gear icon to open options dialog
 */

import m from 'mithril';
import type { OptionsService } from '../services/options-service';
import type { DialogService } from '../services/dialog-service';
import { GearIcon } from './gear-icon';

interface OptionsPanelAttrs {
  optionsService: OptionsService;
  dialogService: DialogService;
}

export const OptionsPanel: m.ClosureComponent<OptionsPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { optionsService, dialogService } = attrs;
      return m('.panel.options', [
        m('button.control.circle', {
          onclick: () => {
            optionsService.openDialog();
            dialogService.onOpen('options');
          },
          title: 'Options'
        }, m(GearIcon))
      ]);
    },
  };
};
