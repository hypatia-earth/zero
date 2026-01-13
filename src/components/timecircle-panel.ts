/**
 * TimeCirclePanel - Date/time display top-right
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { StateService } from '../services/state-service';

interface TimeCirclePanelAttrs {
  stateService: StateService;
}

export const TimeCirclePanel: m.ClosureComponent<TimeCirclePanelAttrs> = (initialVnode) => {
  let unsubscribe: (() => void) | null = null;

  return {
    oncreate() {
      unsubscribe = effect(() => {
        initialVnode.attrs.stateService.viewState.value;
        initialVnode.attrs.stateService.minimalUI.value;
        m.redraw();
      });
    },

    onremove() {
      unsubscribe?.();
    },

    view({ attrs }) {
      const { stateService } = attrs;
      const time = stateService.viewState.value.time;

      const year = time.getUTCFullYear();
      const month = time.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
      const day = time.getUTCDate();
      const hours = String(time.getUTCHours()).padStart(2, '0');
      const minutes = String(time.getUTCMinutes()).padStart(2, '0');

      return m('.panel.timecircle', {
        onclick: () => stateService.toggleMinimalUI(),
      }, [
        m('.control.circle', [
          m('.time-year', year),
          m('.time-date', `${month} ${day}`),
          m('.time-time', `${hours}:${minutes} UTC`),
        ]),
      ]);
    },
  };
};
