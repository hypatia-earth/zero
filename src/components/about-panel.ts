/**
 * AboutPanel - Icon to open about dialog
 */

import m from 'mithril';
import type { DialogService } from '../services/dialog-service';

interface AboutPanelAttrs {
  dialogService: DialogService;
}

export const AboutPanel: m.ClosureComponent<AboutPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { dialogService } = attrs;
      return m('.panel.about', [
        m('button.control.circle', {
          onclick: () => dialogService.open('about', {}),
          title: 'About'
        }, m('img', { src: 'icon-info.svg', alt: 'About' }))
      ]);
    },
  };
};
