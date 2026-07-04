import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base:'./' so the built page loads over file:// inside Playwright —
// no dev server needed, which keeps the harness single-process.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    minify: false,
    sourcemap: false,
  },
});
