import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // bind 0.0.0.0 so Docker port-mapping works
    proxy: {
      '/api': { target: backendUrl, changeOrigin: true },
      '/socket.io': { target: backendUrl, ws: true, changeOrigin: true },
    },
  },
});
