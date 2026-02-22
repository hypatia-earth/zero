/**
 * CameraPanel - Toolbar button to enter camera capture mode
 */

import m from 'mithril';
import type { CameraService } from '../services/camera-service';

interface CameraPanelAttrs {
  cameraService: CameraService;
}

export const CameraPanel: m.ClosureComponent<CameraPanelAttrs> = () => {
  return {
    view({ attrs }) {
      return m('div.camera.panel', [
        m('button.control.circle', {
          onclick: () => attrs.cameraService.enter(),
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
