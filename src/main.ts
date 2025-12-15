console.clear();

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

console.log('%c[ZERO] loading ...', 'color: darkgreen; font-weight: bold');


// Register Service Worker (non-blocking, sets up cache utils on localhost)
registerServiceWorker();

// Mount App immediately - it handles its own loading states
const appContainer = document.getElementById('app');
if (appContainer) {
  m.mount(appContainer, App);
} else {
  console.error('[Zero] App container #app not found');
}
