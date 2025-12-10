import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
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
