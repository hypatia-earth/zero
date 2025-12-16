/**
 * InfoPanel - Lightbulb icon to open info dialog
 */

import m from 'mithril';
import type { InfoService } from '../services/info-service';

interface InfoPanelAttrs {
  infoService: InfoService;
}

export const InfoPanel: m.ClosureComponent<InfoPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { infoService } = attrs;
      return m('.panel.info', [
        m('button.control.circle', {
          onclick: () => infoService.openDialog(),
          title: 'Information'
        }, m('img', { src: 'icon-info.svg', alt: 'Info' }))
      ]);
    },
  };
};
