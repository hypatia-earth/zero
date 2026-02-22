/**
 * App - Main application component
 *
 * Renders as Mithril component with two phases:
 * 1. Bootstrap: Shows modal with progress, UI hidden
 * 2. Ready: Modal fades out, UI fades in
 */

import m from 'mithril';
import { Progress } from './bootstrap/progress';
import { runBootstrap, type ServiceContainer } from './bootstrap';
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
import { CameraPanel } from './components/camera-panel';
import { CameraOverlay } from './components/camera-overlay';
import { PanelStack } from './components/panel-stack';
import { CreateLayerDialog } from './components/create-layer-dialog';
import { Modal } from './components/modal';

export const App: m.ClosureComponent = () => {
  // Progress state for bootstrap modal (created early for subscription)
  const progress = new Progress();

  // Services - populated during bootstrap
  const services: Partial<ServiceContainer> = {};

  return {
    async oninit() {
      // Hide preload message now that app is taking over
      document.getElementById('preload')?.classList.add('hidden');

      const canvas = document.getElementById('globe') as HTMLCanvasElement;
      if (!canvas) {
        progress.setError('Canvas element #globe not found');
        return;
      }

      await runBootstrap(canvas, progress, services);
      m.redraw();
    },

    view() {
      const state = progress.state.value;
      const ready = state.complete && !state.error;
      const minimal = ready && services.stateService!.minimalUI.value;
      const cameraActive = ready && services.cameraService!.mode.value !== 'off';

      return [
        m(BootstrapModal, {
          progressState: progress.state,
          ...(ready ? { optionsService: services.optionsService! } : {}),
        }),
        ...(ready ? [
          m(OptionsDialog, {
            optionsService: services.optionsService!,
            paletteService: services.paletteService!,
            dialogService: services.dialogService!,
            configService: services.configService!,
          }),
          m(AboutDialog, {
            aboutService: services.aboutService!,
            dialogService: services.dialogService!,
          }),
          m(CreateLayerDialog, {
            layerRegistry: services.layerService!,
            auroraService: services.auroraService!,
            dialogService: services.dialogService!,
            modalService: services.modalService!,
            slotService: services.slotService!,
          }),
          m(Modal, { modalService: services.modalService! }),
          m('.ui-container', [
            m(PanelStack, { side: 'left' }, [
              m(LogoPanel),
              !minimal && !cameraActive && m(LayersPanel, {
                configService: services.configService!,
                optionsService: services.optionsService!,
                layerRegistry: services.layerService!,
                auroraService: services.auroraService!,
                dialogService: services.dialogService!,
              }),
            ]),
            m(PanelStack, { side: 'right' }, [
              m(TimeCirclePanel, { stateService: services.stateService! }),
              !minimal && !cameraActive && services.optionsService!.options.value.debug.showPerfPanel &&
                m(PerfPanel, {
                  optionsService: services.optionsService!,
                }),
              !minimal && !cameraActive && m(QueuePanel, {
                queueService: services.queueService!,
                optionsService: services.optionsService!,
                slotService: services.slotService!,
                dialogService: services.dialogService!,
              }),
              !minimal && !cameraActive && m(FullscreenPanel),
              !minimal && m(CameraPanel, { cameraService: services.cameraService! }),
              !minimal && !cameraActive && m(AboutPanel, {
                dialogService: services.dialogService!,
              }),
              !minimal && !cameraActive && m(OptionsPanel, {
                dialogService: services.dialogService!,
              }),
            ]),
            !minimal && !cameraActive && m(TimeBarPanel, {
              optionsService: services.optionsService!,
              stateService: services.stateService!,
              slotService: services.slotService!,
              timestepService: services.timestepService!,
              themeService: services.themeService!,
              layerService: services.layerService!,
            }),
          ]),
          cameraActive && m(CameraOverlay, { cameraService: services.cameraService!, dialogService: services.dialogService! }),
        ] : []),
      ];
    },
  };
};
