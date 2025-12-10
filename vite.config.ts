import { defineConfig } from 'vite';
import fs from 'fs';

export default defineConfig({
  server: {
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
  optimizeDeps: {
    exclude: ['@openmeteo/file-format-wasm'],
  },
});
