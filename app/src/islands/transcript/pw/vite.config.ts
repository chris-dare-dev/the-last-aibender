/**
 * Vite build for the FE-3 transcript island Playwright harness.
 * Build: `pnpm -F aibender-app run pw:build:transcript` → pw/dist/,
 * served over loopback by run-pw.ts.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
