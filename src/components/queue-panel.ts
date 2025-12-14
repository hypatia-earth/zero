/**
 * Queue Panel Component
 *
 * Displays download queue statistics below time circle
 * Subscribes to QueueService.stats signal, debounced to 1s updates
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { debounce } from '../utils/debounce';
import type { IQueueService } from '../config/types';

export interface QueuePanelAttrs {
  queueService: IQueueService;
}

const DEBUG = false;

export const QueuePanel: m.Component<QueuePanelAttrs> = {
  oncreate(vnode) {
    const el = vnode.dom.querySelector('.queue-text') as HTMLElement;

    const update = debounce((queuedBytes: number, etaSeconds: number | undefined) => {
      el.textContent = formatStats(queuedBytes, etaSeconds);
      DEBUG && console.log('[QueuePanel]', el.textContent);
    }, 333);

    effect(() => {
      const stats = vnode.attrs.queueService.stats.value;
      update(stats.bytesQueued, stats.etaSeconds);
    });
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

function formatStats(queuedBytes: number, etaSeconds: number | undefined): string {
  const mb = Math.round(queuedBytes / 1024 / 1024);
  if (mb === 0) return '↓ 0 MB · idle';

  let eta: string;
  if (etaSeconds === undefined) {
    eta = '?s';
  } else if (etaSeconds < 60) {
    eta = `${Math.round(etaSeconds)}s`;
  } else {
    eta = `~${Math.ceil(etaSeconds / 60)}m`;
  }

  return `↓ ${mb} MB · ${eta}`;
}
