/**
 * BootstrapModal - Loading progress overlay
 */

import m from 'mithril';
import { BootstrapService } from '../services/bootstrap-service';

export const BootstrapModal: m.Component = {
  view() {
    const state = BootstrapService.state.value;

    if (state.complete && !state.error) {
      return null;
    }

    return m('.dialog.bootstrap', [
      m('.backdrop'),
      m('.window', [
        m('.branding', [
          m('.logo-text', { style: 'font-size: 28px; font-weight: 300; letter-spacing: 2px;' }, 'HYPATIA'),
          m('.tagline', 'zero'),
        ]),
        m('.progress', [
          m('.progress-text', state.label),
          m('.progress-bar', [
            m('.progress-fill', { style: `width: ${state.progress}%` }),
          ]),
        ]),
        state.error && m('.error', [
          m('p', 'Failed to initialize'),
          m('.detail', state.error),
        ]),
      ]),
    ]);
  },
};
