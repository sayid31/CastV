/**
 * Build khusus untuk website publik (Vercel).
 *
 * Hanya `index.html` (landing page) yang ikut build. `app.html` dan
 * `receiver.html` sengaja TIDAK disertakan supaya website benar-benar
 * hanya berfungsi sebagai halaman pengenalan + unduhan.
 *
 * Aplikasi desktop tetap dibangun penuh oleh `vite.config.ts` (npm run build)
 * dan tetap berisi ketiga halaman.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist-site',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
      },
    },
  },
});
