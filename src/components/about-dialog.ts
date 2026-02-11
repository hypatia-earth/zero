/**
 * AboutDialog - Modal for displaying markdown content
 *
 * Same layout as OptionsDialog:
 * - Modal centered on desktop, slide-up on mobile
 * - Draggable header (desktop only)
 */

import m from 'mithril';
import type { AboutService } from '../services/about-service';
import type { DialogService } from '../services/dialog-service';
import { DialogHeader } from './dialog-header';

export interface AboutDialogAttrs {
  aboutService: AboutService;
  dialogService: DialogService;
}

export const AboutDialog: m.ClosureComponent<AboutDialogAttrs> = () => {
  let wasOpen = false;
  let windowEl: HTMLElement | null = null;

  return {
    view({ attrs }) {
      const { aboutService, dialogService } = attrs;

      if (!dialogService.isOpen('about')) {
        wasOpen = false;
        return null;
      }

      // Load content on open transition
      if (!wasOpen) {
        wasOpen = true;
        const payload = dialogService.getPayload('about');
        aboutService.loadPage(payload?.page ?? 'about');
      }

      const isFloating = dialogService.isFloating('about');
      const isTop = dialogService.isTop('about');
      const isDragging = dialogService.isDragging('about');
      const dragOffset = dialogService.getDragOffset('about');

      const windowStyle: Record<string, string> = {};
      if (dragOffset.x !== 0 || dragOffset.y !== 0) {
        windowStyle.transform = `translate(${dragOffset.x}px, ${dragOffset.y}px)`;
      }

      const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';
      const closingClass = dialogService.isClosing('about') ? 'closing' : '';

      const close = () => {
        dialogService.resetDragState('about');
        dialogService.close('about');
      };

      return m('div.dialog.about', { class: `${floatingClass} ${closingClass}` }, [
        m('div.backdrop', {
          onclick: () => {
            if (dialogService.shouldCloseOnBackdrop('about')) {
              close();
            }
          }
        }),
        m('div.window', {
          class: isDragging ? 'dragging' : '',
          style: windowStyle,
          onmousedown: () => dialogService.bringToFront('about'),
          oncreate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
          onupdate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
        }, [
          m(DialogHeader, {
            dialogId: 'about',
            title: 'About Hypatia Zero',
            dialogService,
            windowEl,
            onClose: close,
          }),
          m('div.content.markdown', [
            aboutService.error
              ? m('div.error', aboutService.error)
              : m.trust(aboutService.content)
          ]),
          m('div.footer', [
            m('span.version', `v${__APP_VERSION__} (${__APP_HASH__})`),
            m('div.actions', [
              m('button.btn.btn-secondary', {
                onclick: (e: MouseEvent) => {
                  const content = (e.target as HTMLElement).closest('.window')?.querySelector('.content');
                  content?.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }, 'Top'),
              m('button.btn.btn-secondary', { onclick: close }, 'Close')
            ])
          ])
        ])
      ]);
    },
  };
};
