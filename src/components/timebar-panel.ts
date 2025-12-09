/**
 * TimeBarPanel - Time slider at bottom
 */

import m from 'mithril';
import type { StateService } from '../services/state-service';
import type { DateTimeService } from '../services/datetime-service';

interface TimeBarPanelAttrs {
  stateService: StateService;
  dateTimeService: DateTimeService;
}

export const TimeBarPanel: m.Component<TimeBarPanelAttrs> = {
  view({ attrs }) {
    const { stateService, dateTimeService } = attrs;
    const currentTime = stateService.getTime();
    const window = dateTimeService.getDataWindow();

    const windowMs = window.end.getTime() - window.start.getTime();
    const currentMs = currentTime.getTime() - window.start.getTime();
    const progress = Math.max(0, Math.min(100, (currentMs / windowMs) * 100));

    const handleInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const value = parseFloat(target.value);
      const newTime = new Date(window.start.getTime() + (value / 100) * windowMs);
      stateService.setTime(newTime);
    };

    const formatDate = (date: Date) => {
      return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    };

    return m('.panel.timebar', [
      m('.control.timeslider', { style: 'width: 100%; height: 42px; position: relative;' }, [
        // Track background
        m('.time-ticks', [
          // Now marker
          m('.time-tick', {
            style: `left: ${((dateTimeService.getWallTime().getTime() - window.start.getTime()) / windowMs) * 100}%; background: rgba(255,255,255,0.5);`,
          }),
        ]),
        // Slider input
        m('input[type=range].timeslider', {
          min: 0,
          max: 100,
          step: 0.1,
          value: progress,
          oninput: handleInput,
        }),
      ]),
      m('.timesteps', { style: 'display: flex; justify-content: space-between; width: 100%; padding: 0 24px; font-size: 12px; opacity: 0.6;' }, [
        m('span', formatDate(window.start)),
        m('span', 'NOW'),
        m('span', formatDate(window.end)),
      ]),
    ]);
  },
};
