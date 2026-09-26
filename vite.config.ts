import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // Single source of truth for the version: package.json.
  // Injected so the landing page download URLs can never drift from the build.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
