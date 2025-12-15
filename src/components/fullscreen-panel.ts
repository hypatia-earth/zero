/**
 * FullscreenPanel Component
 *
 * Displays fullscreen toggle button with icon
 * Hidden when running in standalone mode (added to home screen)
 */

import m from 'mithril';

/**
 * Check if app is running in standalone mode (PWA added to home screen)
 */
function isStandaloneMode(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  // iOS Safari specific
  // @ts-ignore - navigator.standalone is iOS specific
  if (window.navigator.standalone === true) {
    return true;
  }
  return false;
}

export function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

export const FullscreenPanel: m.ClosureComponent = () => {
  return {
    view() {
      if (isStandaloneMode()) {
        return null;
      }

      const isFullscreen = !!document.fullscreenElement;

      return m('div.fullscreen.panel', [
        m('button.control.circle', {
          onclick: toggleFullscreen,
          title: isFullscreen ? 'Exit Fullscreen (F)' : 'Enter Fullscreen (F)'
        }, [
          m('img.fullscreen-icon', {
            src: isFullscreen ? '/icon-fullscreen-on.svg' : '/icon-fullscreen-off.svg',
            alt: isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'
          })
        ])
      ]);
    }
  };
};
