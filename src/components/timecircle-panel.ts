/**
 * TimeCirclePanel - Date/time display top-right
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { OptionsService } from '../services/options-service';

interface TimeCirclePanelAttrs {
  optionsService: OptionsService;
}

export const TimeCirclePanel: m.ClosureComponent<TimeCirclePanelAttrs> = (initialVnode) => {
  let unsubscribe: (() => void) | null = null;

  return {
    oncreate() {
      unsubscribe = effect(() => {
        initialVnode.attrs.optionsService.options.value;
        m.redraw();
      });
    },

    onremove() {
      unsubscribe?.();
    },

    view({ attrs }) {
      const { optionsService } = attrs;
      const time = optionsService.options.value.viewState.time;

      const year = time.getUTCFullYear();
      const month = time.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
      const day = time.getUTCDate();
      const hours = String(time.getUTCHours()).padStart(2, '0');
      const minutes = String(time.getUTCMinutes()).padStart(2, '0');

      return m('.panel.timecircle', [
        m('.control.circle.nohover', [
          m('.time-year', year),
          m('.time-date', `${month} ${day}`),
          m('.time-time', `${hours}:${minutes} UTC`),
        ]),
      ]);
    },
  };
};
