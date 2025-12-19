/**
 * BootstrapModal - Loading progress overlay
 *
 * Shows during bootstrap with progress, fades out on success, stays on error.
 * Stays open with "Start" button for first-time users or when autocloseModal=false.
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { BootstrapService } from '../services/bootstrap-service';
import type { OptionsService } from '../services/options-service';

interface BootstrapModalAttrs {
  optionsService?: OptionsService;
}

export const BootstrapModal: m.ClosureComponent<BootstrapModalAttrs> = () => {
  let fadingOut = false;
  let hidden = false;
  let unsubscribe: (() => void) | null = null;

  const startFadeOut = () => {
    fadingOut = true;
    setTimeout(() => {
      hidden = true;
      m.redraw();
    }, 300);
  };

  return {
    oninit() {
      unsubscribe = effect(() => {
        BootstrapService.state.value;
        m.redraw();
      });
    },

    onremove() {
      unsubscribe?.();
    },

    view({ attrs }) {
      const state = BootstrapService.state.value;
      const { optionsService } = attrs;

      if (hidden) {
        return null;
      }

      // Determine if modal should stay open with Start button
      const shouldStayOpen = optionsService && (
        optionsService.isFirstTimeUser ||
        !optionsService.options.value.interface.autocloseModal
      );

      // Auto fade-out only if not staying open
      if (state.complete && !state.error && !fadingOut && !shouldStayOpen) {
        startFadeOut();
      }

      // Show Start button when complete, no error, and should stay open
      const showStartButton = state.complete && !state.error && shouldStayOpen && !fadingOut;

      return m('.dialog.bootstrap', {
        class: fadingOut ? 'fade-out' : ''
      }, [
        m('.backdrop'),
        m('.window', [
          m('.branding', [
            m('img', {
              src: '/zero.hypatia.earth-brand-white.svg',
              alt: 'Zero - hypatia.earth',
            }),
          ]),
          m('.progress', [
            m('.progress-text', state.label),
            m('.progress-bar', [
              m('.progress-fill', { style: `width: ${state.progress}%` }),
            ]),
          ]),
          state.error && m('.error', [
            m('p', `Failed at: ${state.step}`),
            m('.detail', state.error),
          ]),
          showStartButton && m('.start', [
            m('button.btn.btn-primary', {
              onclick: () => startFadeOut(),
            }, 'Start'),
          ]),
          m('.footer', [
            m('span.version', `v${__APP_VERSION__} (${__APP_HASH__})`)
          ]),
        ]),
      ]);
    },
  };
};
