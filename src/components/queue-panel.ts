/**
 * Queue Panel Component
 *
 * Displays download queue statistics below time circle
 * Subscribes to QueueService.stats signal, debounced to 1s updates
 * Optionally shows GPU memory stats when gpu.showGpuStats is enabled
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import { throttle } from '../utils/debounce';
import type { IQueueService } from '../config/types';
import type { OptionsService } from '../services/options-service';
import type { SlotService } from '../services/slot-service';

export interface QueuePanelAttrs {
  queueService: IQueueService;
  optionsService: OptionsService;
  slotService: SlotService;
}

const DEBUG = false;

export const QueuePanel: m.ClosureComponent<QueuePanelAttrs> = () => {
  const update = throttle((
    el: HTMLElement,
    queuedBytes: number,
    etaSeconds: number | undefined,
    gpuAllocated: number | undefined,
    gpuCapacity: number | undefined,
  ) => {
    el.textContent = formatStats(queuedBytes, etaSeconds, gpuAllocated, gpuCapacity);
    DEBUG && console.log('[QueuePanel]', el.textContent);
  }, 333);

  return {
    oncreate({ dom, attrs }) {
      const el = dom.querySelector<HTMLElement>('.queue-text')!;

      effect(() => {
        const stats = attrs.queueService.stats.value;
        const showGpu = attrs.optionsService.options.value.gpu.showGpuStats;
        let gpuAllocated: number | undefined;
        let gpuCapacity: number | undefined;
        if (showGpu) {
          const memStats = attrs.slotService.getMemoryStats();
          gpuAllocated = memStats.allocatedMB;
          gpuCapacity = memStats.capacityMB;
        }
        update(el, stats.bytesQueued, stats.etaSeconds, gpuAllocated, gpuCapacity);
      });
    },

    view({ attrs }) {
      return m('div.queue.panel', [
        m('button.control.pill', {
          title: 'Download queue',
          onclick: () => attrs.optionsService.openDialog('queue')
        }, [
          m('span.queue-text', '↓ 0 MB · idle')
        ])
      ]);
    }
  };
};

function formatStats(
  queuedBytes: number,
  etaSeconds: number | undefined,
  gpuAllocated: number | undefined,
  gpuCapacity: number | undefined,
): string {
  const mb = Math.round(queuedBytes / 1024 / 1024);

  // Download part
  let download: string;
  if (mb === 0) {
    download = '↓ idle';
  } else {
    let eta: string;
    if (etaSeconds === undefined) {
      eta = '?s';
    } else if (etaSeconds < 60) {
      eta = `${Math.round(etaSeconds)}s`;
    } else {
      eta = `~${Math.ceil(etaSeconds / 60)}m`;
    }
    download = `↓ ${mb} MB · ${eta}`;
  }

  // GPU part (if enabled)
  if (gpuAllocated !== undefined && gpuCapacity !== undefined) {
    const pct = gpuCapacity > 0 ? Math.round((gpuAllocated / gpuCapacity) * 100) : 0;
    const gpu = pct >= 100
      ? `✓ ${formatMB(gpuCapacity)}`
      : `↑ ${pct}%/${formatMB(gpuCapacity)}`;
    return `${download} ${gpu}`;
  }

  return download;
}

function formatMB(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb}MB`;
}
