/**
 * LogoPanel - Brand logo top-left
 * Long-press (3s) triggers reload for PWA testers
 */

import m from 'mithril';

const LONG_PRESS_MS = 3000;

export const LogoPanel: m.ClosureComponent = () => {
  let pressTimer: ReturnType<typeof setTimeout> | null = null;

  const startPress = () => {
    pressTimer = setTimeout(() => {
      location.reload();
    }, LONG_PRESS_MS);
  };

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  return {
    view() {
      return m('.panel.logo', [
        m('a', {
          href: import.meta.env.BASE_URL,
          ontouchstart: startPress,
          ontouchend: cancelPress,
          ontouchcancel: cancelPress,
          onmousedown: startPress,
          onmouseup: cancelPress,
          onmouseleave: cancelPress,
        }, [
          m('img', {
            src: `${import.meta.env.BASE_URL}zero.hypatia.earth-brand-white.svg`,
            alt: 'Zero - hypatia.earth',
          }),
        ]),
      ]);
    },
  };
};
