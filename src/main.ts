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
import { registerServiceWorker, setupCacheUtils } from './services/sw-registration';

// Register Service Worker (non-blocking)
registerServiceWorker();

// Mount App immediately - it handles its own loading states
const appContainer = document.getElementById('app');
if (appContainer) {
  m.mount(appContainer, App);

  // Setup cache utils for debugging (localhost only)
  if (location.hostname === 'localhost') {
    setupCacheUtils();
  }
} else {
  console.error('[Zero] App container #app not found');
}
