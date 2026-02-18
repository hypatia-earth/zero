/**
 * Modal - Transient blocking modal overlay
 *
 * Renders when modalService.current is non-null.
 * Keyboard: Escape → last button (cancel), Enter → first button (primary/danger).
 * Auto-focuses first primary/danger button on open.
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { ModalService, ModalButton } from '../services/modal-service';

interface ModalAttrs {
  modalService: ModalService;
}

export const Modal: m.ClosureComponent<ModalAttrs> = () => {
  let disposeEffect: (() => void) | null = null;
  let isVisible = false;
  let cardEl: HTMLElement | null = null;

  function handleKeydown(modalService: ModalService, buttons: ModalButton[], e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Resolve with last button (cancel/secondary)
      modalService.resolve(buttons[buttons.length - 1]!.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // Resolve with first button (primary/danger)
      modalService.resolve(buttons[0]!.id);
    }
  }

  return {
    oncreate({ attrs }) {
      disposeEffect = effect(() => {
        const config = attrs.modalService.current.value;
        const wasVisible = isVisible;
        isVisible = config !== null;
        if (isVisible !== wasVisible) {
          m.redraw();
        }
      });
    },

    onremove() {
      disposeEffect?.();
    },

    view({ attrs }) {
      const { modalService } = attrs;
      const config = modalService.current.value;
      if (!config) return null;

      const { title, message, buttons } = config;

      const keyHandler = (e: KeyboardEvent) => handleKeydown(modalService, buttons, e);

      return m('.modal', {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-label': title,
        onkeydown: keyHandler,
      }, [
        m('.modal-backdrop', {
          onclick: () => modalService.resolve(buttons[buttons.length - 1]!.id),
        }),
        m('.modal-card', {
          oncreate: (vnode) => {
            cardEl = vnode.dom as HTMLElement;
            // Focus first primary/danger button
            const btn = cardEl.querySelector<HTMLButtonElement>('button.primary, button.danger');
            btn?.focus();
          },
          onupdate: (vnode) => { cardEl = vnode.dom as HTMLElement; },
        }, [
          m('.modal-title', title),
          m('.modal-message', message),
          m('.modal-buttons', buttons.map(btn =>
            m('button', {
              class: btn.variant ?? 'secondary',
              onclick: () => modalService.resolve(btn.id),
            }, btn.label)
          )),
        ]),
      ]);
    },
  };
};
