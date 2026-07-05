import { defineConfig } from 'vitest/config';

/**
 * INTEG suite runner (plan §9.3/§9.4). Mirrors the app/ and core/ vitest
 * configs: `environment: 'node'` by default; individual FE-render seams opt
 * into jsdom per-file with a `// @vitest-environment jsdom` directive (the
 * exact pattern app/src/features/observability/*.spec.tsx uses). JSX is
 * transformed by vitest's built-in esbuild via tsconfig `jsx: react-jsx` —
 * same as the app package's vitest run (its vite react() plugin is a
 * build-only concern, not loaded here).
 *
 * The suite ASSEMBLES seams by reaching into core/src and app/src over
 * relative paths (the sanctioned cross-cutting pattern — see
 * core/scripts/m2-soak/run.ts), so no config alias is needed.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    // Real WebSocket + loopback-HTTP seams need a little headroom over the
    // vitest default; still comfortably a CI-hosted-safe budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
