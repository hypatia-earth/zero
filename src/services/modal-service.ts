/**
 * ModalService - Transient, blocking modal dialogs
 *
 * Promise-based API for confirmations, alerts, and simple prompts.
 * Separate from DialogService (modals are transient/blocking, dialogs are persistent/stackable).
 * Max one modal visible at a time — showing a new one rejects the previous.
 */

import m from 'mithril';
import { signal, type Signal } from '@preact/signals-core';

export interface ModalButton {
  id: string;
  label: string;
  variant?: 'primary' | 'danger' | 'secondary';
}

export interface ModalConfig {
  title: string;
  message: string;
  buttons: ModalButton[];
}

interface ActiveModal {
  config: ModalConfig;
  resolve: (buttonId: string) => void;
}

export class ModalService {
  readonly current: Signal<ModalConfig | null> = signal(null);
  private active: ActiveModal | null = null;

  show(config: ModalConfig): Promise<string> {
    // Resolve previous modal as dismissed (not an error)
    if (this.active) {
      this.active.resolve('');
      this.active = null;
      this.current.value = null;
    }

    return new Promise<string>((resolve) => {
      this.active = { config, resolve };
      this.current.value = config;
      m.redraw();
    });
  }

  resolve(buttonId: string): void {
    if (!this.active) return;
    const { resolve } = this.active;
    this.active = null;
    this.current.value = null;
    resolve(buttonId);
    m.redraw();
  }

  async confirm(title: string, message: string): Promise<boolean> {
    const id = await this.show({
      title,
      message,
      buttons: [
        { id: 'ok', label: 'OK', variant: 'primary' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    return id === 'ok';
  }

  async confirmDelete(itemName: string): Promise<boolean> {
    const id = await this.show({
      title: 'Delete Layer',
      message: `Delete "${itemName}" permanently? This cannot be undone.`,
      buttons: [
        { id: 'delete', label: 'Delete', variant: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    return id === 'delete';
  }
}
