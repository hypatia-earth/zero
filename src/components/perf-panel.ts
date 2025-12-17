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
      const frameEl = dom.querySelector('.perf-frame') as HTMLElement;
      const passEl = dom.querySelector('.perf-pass') as HTMLElement;
      initialVnode.attrs.renderService.setPerfElements(frameEl, passEl);
    },

    onremove() {
      initialVnode.attrs.renderService.setPerfElements(null, null);
    },

    view() {
      return m('div.perf.panel', [
        m('button.control.pill', {
          title: 'Frame timing (60-frame avg)'
        }, [
          m('span.perf-frame', 'frame: -- ms'),
          m('span.perf-pass', '')  // GPU pass time (if timestamp queries available)
        ])
      ]);
    }
  };
};
