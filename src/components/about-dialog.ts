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

export interface AboutDialogAttrs {
  aboutService: AboutService;
  dialogService: DialogService;
}

export const AboutDialog: m.ClosureComponent<AboutDialogAttrs> = () => {
  return {
    view({ attrs }) {
      const { aboutService, dialogService } = attrs;

      if (!aboutService.dialogOpen) return null;

      const isFloating = dialogService.isFloating('about');
      const isTop = dialogService.isTop('about');
      const isDesktop = dialogService.isDesktop;

      // Drag handlers (desktop only)
      const onMouseDown = (e: MouseEvent) => {
        dialogService.bringToFront('about');
        if (!isDesktop) return;
        dragState.isDragging = true;
        dragState.startX = e.clientX - dragState.offsetX;
        dragState.startY = e.clientY - dragState.offsetY;

        const onMouseMove = (e: MouseEvent) => {
          if (!dragState.isDragging) return;
          const win = document.querySelector<HTMLElement>('.dialog.about .window');
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

      const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';

      return m('div.dialog.about', { class: floatingClass }, [
        m('div.backdrop', {
          onclick: () => {
            if (dialogService.shouldCloseOnBackdrop('about')) {
              resetDragState();
              aboutService.closeDialog();
            }
          }
        }),
        m('div.window', {
          class: dragState.isDragging ? 'dragging' : '',
          style: windowStyle,
          onmousedown: () => dialogService.bringToFront('about')
        }, [
          m('div.header', { onmousedown: onMouseDown }, [
            m('h2', 'About Hypatia Zero'),
            m('div.bar', [
              isDesktop ? m('button.float-toggle', {
                onclick: (e: Event) => {
                  e.stopPropagation();
                  dialogService.toggleFloating('about');
                },
                title: isFloating ? 'Disable floating' : 'Keep floating'
              }, isFloating ? '◎' : '○') : null,
              m('button.close', {
                onclick: () => {
                  resetDragState();
                  aboutService.closeDialog();
                }
              }, '×')
            ])
          ]),
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
              m('button.btn.btn-secondary', {
                onclick: () => {
                  resetDragState();
                  aboutService.closeDialog();
                }
              }, 'Close')
            ])
          ])
        ])
      ]);
    },
  };
};
