/**
 * BootstrapModal - Loading progress overlay
 *
 * Shows during bootstrap with progress, fades out on success, stays on error.
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { BootstrapService } from '../services/bootstrap-service';

export const BootstrapModal: m.ClosureComponent = () => {
  let fadingOut = false;
  let hidden = false;
  let unsubscribe: (() => void) | null = null;

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

    view() {
      const state = BootstrapService.state.value;

      if (hidden) {
        return null;
      }

      if (state.complete && !state.error && !fadingOut) {
        fadingOut = true;
        setTimeout(() => {
          hidden = true;
          m.redraw();
        }, 300);
      }

      return m('.dialog.bootstrap', {
        class: fadingOut ? 'fade-out' : ''
      }, [
        m('.backdrop'),
        m('.window', [
          m('.branding', [
            m('img', {
              src: '/zero.hypatia.earth-brand-white.svg',
              alt: 'Zero - hypatia.earth',
              style: 'height: 48px;',
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
          m('.footer', [
            m('span.version', `v${__APP_VERSION__} (${__APP_HASH__})`)
          ]),
        ]),
      ]);
    },
  };
};
