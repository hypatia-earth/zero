import type { Plugin } from 'vite';
import fs from 'fs';

/**
 * Vite plugin to add cache headers for static assets
 */
export function cacheHeaders(): Plugin {
  return {
    name: 'cache-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('.dat')) {
          res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        }
        next();
      });
    },
  };
}
