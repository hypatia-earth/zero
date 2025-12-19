/**
 * Perf Panel Component
 *
 * Displays frame timing statistics
 * DOM updated directly by RenderService (not mithril redraw)
 */

import m from 'mithril';
import type { RenderService } from '../services/render-service';

export interface PerfPanelAttrs {
  renderService: RenderService;
}

export const PerfPanel: m.ClosureComponent<PerfPanelAttrs> = (initialVnode) => {
  return {
    oncreate({ dom }) {
      const frameEl = dom.querySelector<HTMLElement>('.perf-frame');
      const passEl = dom.querySelector<HTMLElement>('.perf-pass');
      const screenEl = dom.querySelector<HTMLElement>('.perf-screen');
      const globeEl = dom.querySelector<HTMLElement>('.perf-globe');
      initialVnode.attrs.renderService.setPerfElements(frameEl, passEl, screenEl, globeEl);
    },

    onremove() {
      initialVnode.attrs.renderService.setPerfElements(null, null, null, null);
    },

    view() {
      return m('div.perf.panel', [
        m('button.control.pill', {
          title: 'Frame timing (60-frame avg)'
        }, [
          m('div', m('span.perf-frame', 'frame: -- ms')),
          m('div', m('span.perf-pass', 'pass: -- ms')),
          m('div', m('span.perf-screen', 'screen: --')),
          m('div', m('span.perf-globe', 'globe: -- px'))
        ])
      ]);
    }
  };
};
