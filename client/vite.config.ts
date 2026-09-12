import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Listens on every interface so a phone on the same Wi-Fi can
    // reach it; localhost alone is unreachable from another device.
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split vendor code so the app shell can be cached independently
        // of the parts that change on every deploy.
        //
        // The function form, rather than the object form, because it only
        // names a chunk for modules that are actually in the graph. The
        // object form emits an empty chunk (and a build warning) for any
        // group nothing imports yet, and a build that always warns is a
        // build whose warnings stop being read.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\/]node_modules[\/](react|react-dom|react-router|react-router-dom)[\/]/.test(id)) {
            return 'react';
          }
          if (/[\/]node_modules[\/]motion/.test(id)) return 'motion';
          if (/[\/]node_modules[\/]d3-/.test(id)) return 'charts';
          return undefined;
        },
      },
    },
  },
});
