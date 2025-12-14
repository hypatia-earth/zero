/**
 * Queue Panel Component
 *
 * Displays download queue statistics below time circle
 * Direct DOM updates from render loop for performance
 */

import m from 'mithril';

// Module-level reference for direct DOM updates
let contentElement: HTMLElement | null = null;

export const QueuePanel: m.Component = {
  oncreate(vnode) {
    contentElement = vnode.dom.querySelector('.queue-text');
  },
  onremove() {
    contentElement = null;
  },
  view() {
    return m('div.queue.panel', [
      m('button.control.pill', {
        title: 'Download queue'
      }, [
        m('span.queue-text', '↓ 0 MB · idle')
      ])
    ]);
  }
};

/**
 * Update queue panel directly (called from render loop, bypasses Mithril)
 */
export function updateQueuePanel(queuedBytes: number, etaSeconds: number | undefined): void {
  if (!contentElement) return;

  const mb = Math.round(queuedBytes / 1024 / 1024);

  if (mb === 0) {
    contentElement.textContent = '↓ 0 MB · idle';
    return;
  }

  const timeStr = formatEta(etaSeconds);
  contentElement.textContent = `↓ ${mb} MB · ${timeStr}`;
}

function formatEta(seconds: number | undefined): string {
  if (seconds === undefined) return '?s';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  return `~${Math.ceil(seconds / 60)}m`;
}
