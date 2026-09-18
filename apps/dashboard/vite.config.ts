import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * In development the dashboard talks to the API through Vite's proxy, so the
 * browser sees one origin and behaves exactly as it does behind the gateway.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    // The console shares the runtime's contracts rather than restating them.
    alias: {
      '@kazi-ai/agentos-core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: Number(process.env.KZ_DASHBOARD_PORT ?? 5173),
    proxy: {
      '/api': {
        target: process.env.KZ_API_URL ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/healthz': { target: process.env.KZ_API_URL ?? 'http://127.0.0.1:4000' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
