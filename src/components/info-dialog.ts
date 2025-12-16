/**
 * InfoDialog - Modal for displaying markdown content
 *
 * Same layout as OptionsDialog:
 * - Modal centered on desktop, slide-up on mobile
 * - Draggable header (desktop only)
 */

import m from 'mithril';
import type { InfoService } from '../services/info-service';

// Drag state (persists across redraws)
let dragState = {
  isDragging: false,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0,
};

function resetDragState(): void {
  dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
}

export interface InfoDialogAttrs {
  infoService: InfoService;
}

export const InfoDialog: m.ClosureComponent<InfoDialogAttrs> = () => {
  return {
    view({ attrs }) {
      const { infoService } = attrs;

      if (!infoService.dialogOpen) return null;

      const isDesktop = window.innerWidth > 600;

      // Drag handlers (desktop only)
      const onMouseDown = (e: MouseEvent) => {
        if (!isDesktop) return;
        dragState.isDragging = true;
        dragState.startX = e.clientX - dragState.offsetX;
        dragState.startY = e.clientY - dragState.offsetY;

        const onMouseMove = (e: MouseEvent) => {
          if (!dragState.isDragging) return;
          dragState.offsetX = e.clientX - dragState.startX;
          dragState.offsetY = e.clientY - dragState.startY;
          m.redraw();
        };

        const onMouseUp = () => {
          dragState.isDragging = false;
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      };

      const dialogStyle = (dragState.offsetX !== 0 || dragState.offsetY !== 0)
        ? { transform: `translate(${dragState.offsetX}px, ${dragState.offsetY}px)` }
        : {};

      return m('div.dialog.info', [
        m('div.backdrop', {
          onclick: () => {
            resetDragState();
            infoService.closeDialog();
          }
        }),
        m('div.window', {
          class: dragState.isDragging ? 'dragging' : '',
          style: dialogStyle
        }, [
          m('div.header', { onmousedown: onMouseDown }, [
            m('h2', 'Information'),
            m('button.close', {
              onclick: () => {
                resetDragState();
                infoService.closeDialog();
              }
            }, '×')
          ]),
          m('div.content.markdown', [
            infoService.loading
              ? m('div.loading', 'Loading...')
              : infoService.error
                ? m('div.error', infoService.error)
                : m.trust(infoService.content)
          ]),
          m('div.footer', [
            m('div.actions', [
              m('button.btn-close', {
                onclick: () => {
                  resetDragState();
                  infoService.closeDialog();
                }
              }, 'Close')
            ])
          ])
        ])
      ]);
    },
  };
};
