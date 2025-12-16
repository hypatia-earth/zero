/**
 * InfoDialog - Modal for displaying markdown content
 *
 * Same layout as OptionsDialog:
 * - Modal centered on desktop, slide-up on mobile
 * - Draggable header (desktop only)
 */

import m from 'mithril';
import type { InfoService } from '../services/info-service';
import type { DialogService } from '../services/dialog-service';

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
  dialogService: DialogService;
}

export const InfoDialog: m.ClosureComponent<InfoDialogAttrs> = () => {
  return {
    view({ attrs }) {
      const { infoService, dialogService } = attrs;

      if (!infoService.dialogOpen) return null;

      const isFloating = dialogService.isFloating('info');
      const zIndex = dialogService.getZIndex('info');
      const isDesktop = dialogService.isDesktop;

      // Drag handlers (desktop only)
      const onMouseDown = (e: MouseEvent) => {
        dialogService.bringToFront('info');
        if (!isDesktop) return;
        dragState.isDragging = true;
        dragState.startX = e.clientX - dragState.offsetX;
        dragState.startY = e.clientY - dragState.offsetY;

        const onMouseMove = (e: MouseEvent) => {
          if (!dragState.isDragging) return;
          const win = document.querySelector('.dialog.info .window') as HTMLElement;
          if (!win) return;
          // Get base rect without current transform
          const baseX = (window.innerWidth - win.offsetWidth) / 2;
          const baseY = (window.innerHeight - win.offsetHeight) / 2;
          const headerHeight = 56;
          // Clamp so header stays in viewport
          const minX = -baseX;
          const maxX = window.innerWidth - baseX - win.offsetWidth;
          const minY = -baseY;
          const maxY = window.innerHeight - baseY - headerHeight;
          dragState.offsetX = Math.max(minX, Math.min(maxX, e.clientX - dragState.startX));
          dragState.offsetY = Math.max(minY, Math.min(maxY, e.clientY - dragState.startY));
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

      const windowStyle: Record<string, string> = {};
      if (dragState.offsetX !== 0 || dragState.offsetY !== 0) {
        windowStyle.transform = `translate(${dragState.offsetX}px, ${dragState.offsetY}px)`;
      }

      const dialogStyle = isFloating ? { zIndex: String(zIndex) } : {};

      return m('div.dialog.info', { class: isFloating ? 'floating' : '', style: dialogStyle }, [
        m('div.backdrop', {
          onclick: () => {
            if (dialogService.shouldCloseOnBackdrop('info')) {
              resetDragState();
              infoService.closeDialog();
            }
          }
        }),
        m('div.window', {
          class: dragState.isDragging ? 'dragging' : '',
          style: windowStyle,
          onmousedown: () => dialogService.bringToFront('info')
        }, [
          m('div.header', { onmousedown: onMouseDown }, [
            m('h2', 'Information'),
            m('div.bar', [
              isDesktop ? m('button.float-toggle', {
                onclick: (e: Event) => {
                  e.stopPropagation();
                  dialogService.toggleFloating('info');
                },
                title: isFloating ? 'Disable floating' : 'Keep floating'
              }, isFloating ? '◎' : '○') : null,
              m('button.close', {
                onclick: () => {
                  resetDragState();
                  infoService.closeDialog();
                }
              }, '×')
            ])
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
