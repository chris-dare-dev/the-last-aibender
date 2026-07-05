/**
 * Vite build for the FE-4 graph island Playwright harness.
 * Build: `pnpm -F aibender-app run pw:build:graph` → pw/dist/, served over
 * loopback by run-pw.ts (module workers + ES modules are CORS-blocked on
 * file://).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    // The layout worker is a MODULE worker (Vite path, Safari 15+).
    format: 'es',
  },
});
