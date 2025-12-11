/**
 * TimeBarPanel - Time slider at bottom
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { StateService } from '../services/state-service';
import type { DateTimeService } from '../services/datetime-service';
import type { BudgetService } from '../services/budget-service';

const DEBUG = false;

interface TimeBarPanelAttrs {
  stateService: StateService;
  dateTimeService: DateTimeService;
  budgetService: BudgetService;
}

let unsubscribe: (() => void) | null = null;

export const TimeBarPanel: m.Component<TimeBarPanelAttrs> = {
  oncreate({ attrs }) {
    unsubscribe = effect(() => {
      attrs.stateService.state.value;
      attrs.budgetService.slotsVersion.value;  // Also watch slot changes
      m.redraw();
    });
  },
  onremove() {
    unsubscribe?.();
    unsubscribe = null;
  },
  view({ attrs }) {
    const { stateService, dateTimeService, budgetService } = attrs;
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

    // Get loaded timesteps for tick visualization
    const loadedTimestamps = budgetService.getLoadedTimestamps();
    const activePair = budgetService.getActivePair();
    DEBUG && console.log(`[Timebar] Loaded: ${loadedTimestamps.length}, active: ${activePair ? 'yes' : 'no'}`);

    // Calculate position for a timestamp
    const getPosition = (ts: Date) => ((ts.getTime() - window.start.getTime()) / windowMs) * 100;

    return m('.panel.timebar', [
      m('.control.timeslider', { style: 'width: 100%; height: 42px; position: relative;' }, [
        // Track background with loaded ticks
        m('.time-ticks', [
          // Loaded timestep ticks
          ...loadedTimestamps.map(ts => {
            const isActive = activePair && (
              ts.getTime() === activePair.t0.getTime() ||
              ts.getTime() === activePair.t1.getTime()
            );
            return m('.time-tick', {
              style: `left: ${getPosition(ts)}%; background: ${isActive ? '#0f0' : '#f00'};`,
            });
          }),
          // Now marker (brighter)
          m('.time-tick', {
            style: `left: ${getPosition(dateTimeService.getWallTime())}%; background: rgba(255,255,255,0.7); width: 3px;`,
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
