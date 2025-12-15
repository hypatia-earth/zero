console.clear();

// Listen for SW logs via BroadcastChannel
new BroadcastChannel('sw-log').onmessage = (e) => console.log(e.data);

/**
 * Hypatia Zero - Entry point
 *
 * Mounts App component immediately. App handles:
 * 1. "Please wait" guard until services init
 * 2. Bootstrap modal with progress
 * 3. UI visibility after bootstrap completes
 */

import m from 'mithril';

import './styles/theme.css';
import './styles/layout.css';
import './styles/panels.css';
import './styles/controls.css';
import './styles/dialogs.css';
import './styles/widgets.css';

import { App } from './app';
import { registerServiceWorker } from './services/sw-registration';

console.log(`%c[ZERO] v${__APP_VERSION__} (${__APP_HASH__})`, 'color: darkgreen; font-weight: bold');

async function main() {
  // Register Service Worker first - we need cache stats
  await registerServiceWorker();

  // Mount App - it handles its own loading states
  const appContainer = document.getElementById('app');
  if (appContainer) {
    m.mount(appContainer, App);
  } else {
    console.error('[Zero] App container #app not found');
  }
}

main();
