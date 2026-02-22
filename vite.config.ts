import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import { execSync } from 'child_process';

// Get version and git hash for build
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

/**
 * Vite plugin to add cache headers for static assets
 */
function cacheHeaders(): Plugin {
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

/**
 * Vite plugin to serve public/external/ JS files as ES modules in dev.
 * Vite blocks dynamic import() of JS in public/; this middleware intercepts
 * the ?import query that Vite's import analysis injects and serves the raw file.
 */
function servePublicModules(): Plugin {
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

export default defineConfig({
  base: process.env.BASE_URL || '/',
  plugins: [cacheHeaders(), servePublicModules()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_HASH__: JSON.stringify(gitHash),
  },
  server: {
    host: true,  // Expose to network
    port: 5173,
    strictPort: true,
    // Allows build without certs
    https: fs.existsSync('../certs/hypatia-key.pem') ? {
      key: fs.readFileSync('../certs/hypatia-key.pem'),
      cert: fs.readFileSync('../certs/hypatia.pem'),
    } : undefined,
    fs: {
      allow: ['..'],  // Allow serving files from parent (for npm linked packages)
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      external: ['/external/gifenc.js'],
    },
  },
  worker: {
    format: 'es',
  },
});
