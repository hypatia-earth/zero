/**
 * BootstrapModal - Loading progress overlay
 *
 * Shows during bootstrap with progress, fades out on success, stays on error.
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { BootstrapService } from '../services/bootstrap-service';

interface BootstrapModalState {
  fadingOut: boolean;
  hidden: boolean;
  unsubscribe: (() => void) | null;
}

export const BootstrapModal: m.Component<object, BootstrapModalState> = {
  oninit(vnode) {
    
    vnode.state.fadingOut = false;
    vnode.state.hidden = false;

    // Subscribe to bootstrap state changes
    vnode.state.unsubscribe = effect(() => {
      BootstrapService.state.value;
      m.redraw();
    });
    
  },

  onremove(vnode) {
    vnode.state.unsubscribe?.();
  },

  view(vnode) {
    const state = BootstrapService.state.value;
    const { fadingOut, hidden } = vnode.state;

    // Already hidden after fade-out completed
    if (hidden) {
      return null;
    }

    // Start fade-out when complete without error
    if (state.complete && !state.error && !fadingOut) {
      vnode.state.fadingOut = true;
      // Hide after animation completes
      setTimeout(() => {
        vnode.state.hidden = true;
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
      ]),
    ]);
  },
};
