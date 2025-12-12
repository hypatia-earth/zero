/**
 * LogoPanel - Brand logo top-left
 */

import m from 'mithril';

export const LogoPanel: m.Component = {
  view() {
    return m('.panel.logo', [
      m('a', { href: '/' }, [
        m('img', {
          src: '/zero.hypatia.earth-brand-white.svg',
          alt: 'Zero - hypatia.earth',
          style: 'height: 40px;',
        }),
      ]),
    ]);
  },
};
