/**
 * TimeCirclePanel - Date/time display top-right
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { StateService } from '../services/state-service';

interface TimeCirclePanelAttrs {
  stateService: StateService;
}

let unsubscribe: (() => void) | null = null;

export const TimeCirclePanel: m.Component<TimeCirclePanelAttrs> = {
  oncreate({ attrs }) {
    // Subscribe to state signal and trigger redraw on change
    unsubscribe = effect(() => {
      attrs.stateService.state.value; // Access to track
      m.redraw();
    });
  },
  onremove() {
    unsubscribe?.();
    unsubscribe = null;
  },
  view({ attrs }) {
    const { stateService } = attrs;
    const time = stateService.getTime();

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
