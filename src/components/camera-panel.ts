/**
 * CameraPanel - Toolbar button to enter camera capture mode
 */

import m from 'mithril';
import type { CaptureService } from '../services/capture/capture-service';

interface CameraPanelAttrs {
  captureService: CaptureService;
}

export const CameraPanel: m.ClosureComponent<CameraPanelAttrs> = () => {
  return {
    view({ attrs }) {
      return m('div.camera.panel.desktop-only', [
        m('button.control.circle', {
          onclick: () => attrs.captureService.enter(),
          title: 'Camera',
        }, [
          m('img', {
            src: `${import.meta.env.BASE_URL}icon-camera.svg`,
            alt: 'Camera',
          }),
        ]),
      ]);
    },
  };
};
