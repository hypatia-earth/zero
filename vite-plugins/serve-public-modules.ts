import type { Plugin } from 'vite';
import fs from 'fs';

/**
 * Vite plugin to serve public/external/ JS files as ES modules in dev.
 * Vite blocks dynamic import() of JS in public/; this middleware intercepts
 * the ?import query that Vite's import analysis injects and serves the raw file.
 */
export function servePublicModules(): Plugin {
  return {
    name: 'serve-public-modules',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/external/') && req.url.endsWith('.js?import')) {
          const filePath = 'public' + req.url.replace('?import', '');
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(filePath, 'utf-8'));
            return;
          }
        }
        next();
      });
    },
  };
}
