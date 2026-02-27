import { defineConfig, type Plugin, loadEnv } from 'vite';
import viteWesl from 'wesl-plugin/vite';
import fs from 'fs';
import { execSync } from 'child_process';
import { cacheHeaders } from './vite-plugins/cache-headers';
import { servePublicModules } from './vite-plugins/serve-public-modules';
import { geonamesProxy } from './vite-plugins/geonames-proxy';
import { omArchive } from './vite-plugins/om-archive';

// Get version and git hash for build
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  return {
    base: process.env.BASE_URL || '/',
    plugins: [
      viteWesl(),
      cacheHeaders(),
      servePublicModules(),
      geonamesProxy(env),
      omArchive(),
    ].filter(Boolean) as Plugin[],
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
      plugins: () => [viteWesl()],
    },
  };
});
