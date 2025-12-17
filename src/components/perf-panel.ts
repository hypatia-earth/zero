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
      const el = dom.querySelector('.perf-text') as HTMLElement;
      initialVnode.attrs.renderService.setPerfElement(el);
    },

    onremove() {
      initialVnode.attrs.renderService.setPerfElement(null);
    },

    view() {
      return m('div.perf.panel', [
        m('button.control.pill', {
          title: 'Frame timing (60-frame avg)'
        }, [
          m('span.perf-text', 'pass: -- ms')
        ])
      ]);
    }
  };
};
