import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context. basicSsl gives every headset on the LAN
// an https:// origin during development; production builds are static files
// that can be served from any local https server or sideloaded as a PWA.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: {
    https: true,
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
