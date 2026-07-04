/**
 * Vite build for the FE-3 terminal island Playwright harness.
 * Build: `pnpm -F aibender-app run pw:build:terminal` → pw/dist/,
 * served over loopback by run-pw.ts (ES modules are CORS-blocked on file://).
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
});
