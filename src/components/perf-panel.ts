/**
 * Perf Panel Component
 *
 * Displays frame timing statistics
 * TODO: Get timing from worker frameComplete messages
 */

import m from 'mithril';
import type { OptionsService } from '../services/options-service';

export interface PerfPanelAttrs {
  optionsService: OptionsService;
}

export const PerfPanel: m.ClosureComponent<PerfPanelAttrs> = () => {
  return {
    view({ attrs }) {
      const opts = attrs.optionsService.options.value.gpu;
      return m('div.perf.panel.grid', [
        m('button.control.pill', {
          title: 'Frame timing (60-frame avg)'
        }, [
          m('span.label', 'fps'),
          m('span.perf-fps', '—'),
          m('span.label', 'frame'),
          m('span.perf-frame', '—'),
          m('span.label', 'pass'),
          m('span.perf-pass', '—'),
          m('span.label', 'dropped'),
          m('span.perf-dropped', '0'),
          m('span.label', 'screen'),
          m('span.perf-screen', '—'),
          m('span.label', 'globe'),
          m('span.perf-globe', '—'),
          m('span.label', 'slots'),
          m('span.perf-slots', opts.timeslotsPerLayer),
          m('span.label', 'pool'),
          m('span.perf-pool', opts.workerPoolSize),
        ])
      ]);
    }
  };
};
