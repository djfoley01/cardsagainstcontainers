import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Match the server's import specifiers so shared types and constants are
      // written once and used by both sides.
      '@cac/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // In dev the client runs on its own port; the game socket and API live on
    // the server. In production one process serves both and this is unused.
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/healthz': { target: 'http://localhost:3000' },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
