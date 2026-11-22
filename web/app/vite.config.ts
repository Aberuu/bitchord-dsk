import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: {
    DEV_EXTENSION_ID: JSON.stringify(''),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // essentia.js Emscripten glue breaks under Vite dep pre-bundling.
  optimizeDeps: { exclude: ['essentia.js'] },
  worker: { format: 'es' as const },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
