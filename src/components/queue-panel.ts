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

export const QueuePanel: m.ClosureComponent<QueuePanelAttrs> = () => {
  const update = throttle((
    dom: HTMLElement,
    queuedBytes: number,
    etaSeconds: number | undefined,
    gpuAllocated: number | undefined,
    gpuCapacity: number | undefined,
  ) => {
    const dlInfo = dom.querySelector<HTMLElement>('.queue-dl-info')!;
    const gpuRow = dom.querySelector<HTMLElement>('.queue-gpu-row')!;
    const gpuIcon = dom.querySelector<HTMLElement>('.queue-gpu-icon')!;
    const gpuInfo = dom.querySelector<HTMLElement>('.queue-gpu-info')!;

    // Download info
    const mb = Math.round(queuedBytes / 1024 / 1024);
    if (mb === 0) {
      dlInfo.textContent = 'idle';
    } else {
      let eta: string;
      if (etaSeconds === undefined) {
        eta = '?s';
      } else if (etaSeconds < 60) {
        eta = `${Math.round(etaSeconds)}s`;
      } else {
        eta = `~${Math.ceil(etaSeconds / 60)}m`;
      }
      dlInfo.textContent = `${mb} MB · ${eta}`;
    }

    // GPU info
    if (gpuAllocated !== undefined && gpuCapacity !== undefined) {
      gpuRow.style.display = 'contents';
      const pct = gpuCapacity > 0 ? Math.round((gpuAllocated / gpuCapacity) * 100) : 0;
      if (pct >= 100) {
        gpuIcon.textContent = '✓';
        gpuInfo.textContent = formatMB(gpuCapacity);
      } else {
        gpuIcon.textContent = '↑';
        gpuInfo.textContent = `${pct}% / ${formatMB(gpuCapacity)}`;
      }
    } else {
      gpuRow.style.display = 'none';
    }
  }, 333);

  return {
    oncreate({ dom, attrs }) {
      const el = dom as HTMLElement;
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
      return m('div.queue.panel.grid', [
        m('button.control.pill', {
          title: 'Download queue',
          onclick: () => attrs.optionsService.openDialog('queue')
        }, [
          m('span.label', '↓'),
          m('span.queue-dl-info', 'idle'),
          m('span.queue-gpu-row', { style: 'display: contents' }, [
            m('span.label.queue-gpu-icon', '↑'),
            m('span.queue-gpu-info', '—'),
          ]),
        ])
      ]);
    }
  };
};

function formatMB(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb}MB`;
}
