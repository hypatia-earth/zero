/**
 * CapturePanel - Toolbar button to enter capture mode
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';

interface CapturePanelAttrs {
  captureService: CaptureService;
}

export const CapturePanel: m.ClosureComponent<CapturePanelAttrs> = () => {
  return {
    view({ attrs }) {
      return m('div.capture.panel.desktop-only', [
        m('button.control.circle', {
          onclick: () => attrs.captureService.enter(),
          disabled: !attrs.captureService.isQueueIdle,
          title: 'Capture',
        }, [
          m('img', {
            src: `${import.meta.env.BASE_URL}icon-camera.svg`,
            alt: 'Capture',
          }),
        ]),
      ]);
    },
  };
};
