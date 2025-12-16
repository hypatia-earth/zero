/**
 * InfoPanel - Lightbulb icon to open info dialog
 */

import m from 'mithril';
import type { InfoService } from '../services/info-service';
import type { DialogService } from '../services/dialog-service';

interface InfoPanelAttrs {
  infoService: InfoService;
  dialogService: DialogService;
}

export const InfoPanel: m.ClosureComponent<InfoPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { infoService, dialogService } = attrs;
      return m('.panel.info', [
        m('button.control.circle', {
          onclick: () => {
            infoService.openDialog();
            dialogService.onOpen('info');
          },
          title: 'Information'
        }, m('img', { src: 'icon-info.svg', alt: 'Info' }))
      ]);
    },
  };
};
