/**
 * Service Worker messaging utility
 *
 * Sends messages to SW via MessageChannel and waits for response.
 */

const SW_TIMEOUT_MS = 5000;

/**
 * Send message to Service Worker and wait for response
 * Uses MessageChannel for two-way communication with timeout
 */
export async function sendSWMessage<T>(message: object): Promise<T> {
  const target = navigator.serviceWorker.controller
    || (await navigator.serviceWorker.ready).active;

  if (!target) {
    throw new Error('No active Service Worker');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      reject(new Error('SW message timeout'));
    }, SW_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data as T);
    };
    target.postMessage(message, [channel.port2]);
  });
}
