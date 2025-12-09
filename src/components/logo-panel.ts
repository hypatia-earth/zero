/**
 * LogoPanel - Brand logo top-left
 */

import m from 'mithril';

export const LogoPanel: m.Component = {
  view() {
    return m('.panel.logo', [
      m('div', { style: 'font-size: 24px; font-weight: 300; letter-spacing: 3px;' }, 'HYPATIA'),
      m('div', { style: 'font-size: 12px; opacity: 0.5; letter-spacing: 1px;' }, 'zero'),
    ]);
  },
};
