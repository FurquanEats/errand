import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number(process.env.ERRAND_PORT ?? 4747);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '^/api/': { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
  },
});
