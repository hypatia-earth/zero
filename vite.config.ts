import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

/**
 * Vite plugin to obfuscate WGSL shaders in production builds
 */
function wgslObfuscate(): Plugin {
  return {
    name: 'wgsl-obfuscate',
    enforce: 'pre',
    transform(code, id) {
      // Only process .wgsl files imported with ?raw
      if (!id.endsWith('.wgsl?raw')) return null;
      // Only obfuscate in production
      if (process.env.NODE_ENV !== 'production') return null;

      const wgslPath = id.replace('?raw', '');
      const tmpOut = path.join('/tmp', `wgsl-${Date.now()}.wgsl`);

      try {
        execSync(`npx wgsl-plus "${wgslPath}" -o "${tmpOut}" --obfuscate`, {
          stdio: 'pipe',
        });
        const obfuscated = fs.readFileSync(tmpOut, 'utf-8');
        fs.unlinkSync(tmpOut);
        return `export default ${JSON.stringify(obfuscated)}`;
      } catch (e) {
        console.warn('[wgsl-obfuscate] Failed, using original:', e);
        return null;
      }
    },
  };
}

export default defineConfig({
  plugins: [wgslObfuscate()],
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
    rollupOptions: {
      external: (id) => id === '@openmeteo/file-format-wasm',
    },
  },
});
