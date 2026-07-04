/**
 * FE-2 app build config (vite 8, locked pin). The SPA is the Tauri WKWebView
 * bundle AND the free second frontend (Chrome on localhost) — nothing here
 * is Tauri-specific beyond the fixed dev port the shell's devUrl points at.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // WKWebView on macOS 26.x — modern Safari baseline.
    target: 'safari16',
    outDir: 'dist',
  },
});
