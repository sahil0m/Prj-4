import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * The participant app.
 *
 * This page opens on a phone, often on saturated conference wifi, and often
 * a hundred at once. Everything here serves loading fast: no vendor split
 * (one small file beats three round trips), no sourcemaps in the bundle the
 * audience downloads, and a hard budget enforced by scripts/check-bundle-size.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Preact's React shim, which is API-compatible with everything this
      // app uses (hooks, StrictMode, createRoot). React and React DOM are
      // roughly 40KB gzipped; Preact is about 4KB, and on a phone joining a
      // session over conference wifi that difference is most of the wait.
      // The presenter app keeps real React — it is not size constrained and
      // uses libraries that expect it.
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
  build: {
    target: 'es2020',
    // Kept out of the download; the server still has them for debugging.
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // One chunk. At this size, splitting costs more in requests than it
        // saves in bytes.
        manualChunks: undefined,
      },
    },
  },
});
