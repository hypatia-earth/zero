/**
 * AboutPanel - Icon to open about dialog
 */

import m from 'mithril';
import type { AboutService } from '../services/about-service';
import type { DialogService } from '../services/dialog-service';

interface AboutPanelAttrs {
  aboutService: AboutService;
  dialogService: DialogService;
}

export const AboutPanel: m.ClosureComponent<AboutPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const { aboutService, dialogService } = attrs;
      return m('.panel.about', [
        m('button.control.circle', {
          onclick: () => {
            aboutService.openDialog();
            dialogService.onOpen('about');
          },
          title: 'About'
        }, m('img', { src: 'icon-info.svg', alt: 'About' }))
      ]);
    },
  };
};
