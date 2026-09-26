import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // Public landing page (deployed to Vercel / served as site root).
        landing: resolve(__dirname, 'index.html'),
        // Desktop application shell loaded by Electron.
        app: resolve(__dirname, 'app.html'),
        // Web receiver opened from phones, tablets and the Android TV app.
        receiver: resolve(__dirname, 'receiver.html'),
      },
    },
  },
});
