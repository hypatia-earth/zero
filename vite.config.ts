import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

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
 * Vite plugin to process WGSL shaders with wgsl-plus
 * - Watches all *.wgsl files in shaders folder
 * - Runs wgsl-plus master.wgsl -o zero.wgsl on changes
 * - Dev: link only, Prod: link + obfuscate
 */
function wgslProcess(): Plugin {
  const shadersDir = path.resolve(__dirname, 'src/render/shaders');
  const masterPath = path.join(shadersDir, 'master.wgsl');
  const outputPath = path.join(shadersDir, 'zero.wgsl');

  function buildShaders(isProd: boolean) {
    const obfuscateFlag = isProd ? ' --obfuscate' : '';
    try {
      execSync(`npx wgsl-plus "${masterPath}" -o "${outputPath}"${obfuscateFlag}`, {
        stdio: 'pipe',
        cwd: shadersDir,
      });
      console.log(`[wgsl] Built zero.wgsl (${isProd ? 'obfuscated' : 'linked'})`);
    } catch (e) {
      console.error('[wgsl] Build failed:', e);
    }
  }

  return {
    name: 'wgsl-process',
    buildStart() {
      const isProd = process.env.NODE_ENV === 'production';
      buildShaders(isProd);
    },
    configureServer(server) {
      // Watch all .wgsl files except zero.wgsl
      server.watcher.add(path.join(shadersDir, '*.wgsl'));
      server.watcher.on('change', (file) => {
        if (file.endsWith('.wgsl') && !file.endsWith('zero.wgsl')) {
          console.log(`[wgsl] ${path.basename(file)} changed, rebuilding...`);
          buildShaders(false);
          // Trigger HMR by invalidating zero.wgsl
          const mod = server.moduleGraph.getModuleById(outputPath + '?raw');
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [cacheHeaders(), wgslProcess()],
  server: {
    host: true,  // Expose to network
    port: 5173,
    strictPort: true,
    https: {
      key: fs.readFileSync('../certs/hypatia-key.pem'),
      cert: fs.readFileSync('../certs/hypatia.pem'),
    },
    fs: {
      allow: ['..'],  // Allow serving files from parent (for npm linked packages)
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
