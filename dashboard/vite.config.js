import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': 'http://gateway:3000',
      '/ws': { target: 'ws://gateway:3000', ws: true },
    },
  },
});
