import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 47320,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.LV_PORT ?? 47319}` },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
