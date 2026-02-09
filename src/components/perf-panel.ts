/**
 * Perf Panel Component
 *
 * Displays frame timing statistics.
 * DOM updated directly by PerfService (not mithril redraw).
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
          m('span.label', 'p1'),
          m('span.perf-pass1', '—'),
          m('span.label', 'p2'),
          m('span.perf-pass2', '—'),
          m('span.label', 'p3'),
          m('span.perf-pass3', '—'),
          m('span.label', 'drop'),
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
