/**
 * Perf Panel Component
 *
 * Displays frame timing statistics
 * DOM updated directly by RenderService (not mithril redraw)
 */

import m from 'mithril';
import type { RenderService } from '../services/render-service';
import type { OptionsService } from '../services/options-service';

export interface PerfPanelAttrs {
  renderService: RenderService;
  optionsService: OptionsService;
}

export const PerfPanel: m.ClosureComponent<PerfPanelAttrs> = (initialVnode) => {
  return {
    oncreate({ dom }) {
      const fpsEl = dom.querySelector<HTMLElement>('.perf-fps');
      const frameEl = dom.querySelector<HTMLElement>('.perf-frame');
      const passEl = dom.querySelector<HTMLElement>('.perf-pass');
      const screenEl = dom.querySelector<HTMLElement>('.perf-screen');
      const globeEl = dom.querySelector<HTMLElement>('.perf-globe');
      initialVnode.attrs.renderService.setPerfElements(fpsEl, frameEl, passEl, screenEl, globeEl);
    },

    onremove() {
      initialVnode.attrs.renderService.setPerfElements(null, null, null, null, null);
    },

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
          m('span.label', 'screen'),
          m('span.perf-screen', '—'),
          m('span.label', 'globe'),
          m('span.perf-globe', '—'),
          m('span.label', 'slots'),
          m('span', opts.timeslotsPerLayer),
          m('span.label', 'pool'),
          m('span', opts.workerPoolSize),
        ])
      ]);
    }
  };
};
