/**
 * DialogHeader - Shared header component for all dialogs
 *
 * Features:
 * - Draggable on desktop (when floating)
 * - Float toggle button (desktop only)
 * - Close button
 */

import m from 'mithril';
import type { DialogService, DialogId } from '../services/dialog-service';

export interface DialogHeaderAttrs {
  dialogId: DialogId;
  title: string;
  dialogService: DialogService;
  windowEl: HTMLElement | null;
  onClose: () => void;
}

export const DialogHeader: m.Component<DialogHeaderAttrs> = {
  view({ attrs }) {
    const { dialogId, title, dialogService, windowEl, onClose } = attrs;

    const isFloating = dialogService.isFloating(dialogId);
    const isDesktop = dialogService.isDesktop;

    const onMouseDown = (e: MouseEvent) => {
      dialogService.bringToFront(dialogId);
      if (!isDesktop) return;
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      if (!windowEl) return;
      dialogService.startDrag(dialogId, e, windowEl);
    };

    return m('div.header', { onmousedown: onMouseDown }, [
      m('h2', title),
      m('div.bar', [
        isDesktop ? m('button.float-toggle', {
          onclick: (e: Event) => {
            e.stopPropagation();
            dialogService.toggleFloating(dialogId);
          },
          title: isFloating ? 'Disable floating' : 'Keep floating'
        }, isFloating ? '◎' : '○') : null,
        m('button.close', {
          onclick: () => {
            dialogService.resetDragState(dialogId);
            onClose();
          }
        }, '×')
      ])
    ]);
  }
};
