/**
 * App - Main application component
 *
 * Renders as Mithril component with two phases:
 * 1. Bootstrap: Shows modal with progress, UI hidden
 * 2. Ready: Modal fades out, UI fades in
 */

import m from 'mithril';
import { Progress } from './bootstrap/progress';
import { runBootstrap, exposeDebugServices, type ServiceContainer } from './bootstrap';
import { BootstrapModal } from './components/bootstrap-modal';
import { OptionsDialog } from './components/options-dialog';
import { AboutDialog } from './components/about-dialog';
import { AboutPanel } from './components/about-panel';
import { LayersPanel } from './components/layers-panel';
import { TimeCirclePanel } from './components/timecircle-panel';
import { QueuePanel } from './components/queue-panel';
import { PerfPanel } from './components/perf-panel';
import { TimeBarPanel } from './components/timebar';
import { LogoPanel } from './components/logo-panel';
import { OptionsPanel } from './components/options-panel';
import { FullscreenPanel } from './components/fullscreen-panel';
import { PanelStack } from './components/panel-stack';

export const App: m.ClosureComponent = () => {
  // Progress state for bootstrap modal (created early for subscription)
  const progress = new Progress();

  // Services - populated during bootstrap
  let services: ServiceContainer | null = null;

  return {
    async oninit() {
      // Hide preload message now that app is taking over
      document.getElementById('preload')?.classList.add('hidden');

      const canvas = document.getElementById('globe') as HTMLCanvasElement;
      if (!canvas) {
        progress.setError('Canvas element #globe not found');
        return;
      }

      const result = await runBootstrap(canvas, progress);
      if (result.services) {
        services = result.services;
        exposeDebugServices(services);
      }
      m.redraw();
    },

    view() {
      const state = progress.state.value;
      const ready = state.complete && !state.error;

      return [
        m(BootstrapModal, {
          progressState: progress.state,
          ...(ready && services ? { optionsService: services.optionsService } : {}),
        }),
        ...(ready && services ? [
          m(OptionsDialog, {
            optionsService: services.optionsService,
            paletteService: services.paletteService!,
            dialogService: services.dialogService,
            configService: services.configService,
          }),
          m(AboutDialog, {
            aboutService: services.aboutService,
            dialogService: services.dialogService,
          }),
          m('.ui-container', [
            m(PanelStack, { side: 'left' }, [
              m(LogoPanel),
              m(LayersPanel, {
                configService: services.configService,
                optionsService: services.optionsService,
              }),
            ]),
            m(PanelStack, { side: 'right' }, [
              m(TimeCirclePanel, { stateService: services.stateService }),
              services.optionsService.options.value.debug.showPerfPanel &&
                m(PerfPanel, {
                  renderService: services.renderService!,
                  optionsService: services.optionsService,
                }),
              m(QueuePanel, {
                queueService: services.queueService,
                optionsService: services.optionsService,
                slotService: services.slotService!,
              }),
              m(FullscreenPanel),
              m(AboutPanel, {
                aboutService: services.aboutService,
                dialogService: services.dialogService,
              }),
              m(OptionsPanel, {
                optionsService: services.optionsService,
                dialogService: services.dialogService,
              }),
            ]),
            m(TimeBarPanel, {
              optionsService: services.optionsService,
              stateService: services.stateService,
              slotService: services.slotService!,
              timestepService: services.timestepService,
              configService: services.configService,
              themeService: services.themeService,
            }),
          ]),
        ] : []),
      ];
    },
  };
};
