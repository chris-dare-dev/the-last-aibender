# app/ — Tauri v2 application (FRONTEND department)

**Gate state (plan §5):** `DESIGN.md` is **LOCKED** (FE-ORCH, 2026-07-04) —
the FE-1 gate is satisfied and the M2 FE packages have landed in this
directory. Everything visual is token-locked: `pnpm -F aibender-app
lint:tokens` must stay green (DESIGN.md §8.3; the theme suite seeds and
asserts its own violations).

## Layout (ownership per plan §2/§5)

- `src/chrome/theme/` — **FE-ORCH-owned** (FE-1) token source of truth:
  `tokens.ts` → generated `tokens.css` + `tailwind.theme.css`
  (`pnpm -F aibender-app build:tokens`; drift-guarded by `theme.spec.ts`).
- `src-tauri/` + `src/chrome/` (minus `theme/`) + `src/lib/` + `index.html` +
  `src/main.tsx` — **FE-2**: shell (tray/notifications/window/`--smoke-test`,
  see `src-tauri/README.md`), cockpit chrome (three zones, five fixed channel
  panels, ⌘K palette, THE approval inbox, settings), gateway WS client
  (bootstrap discovery, reconnect-replay watermarks, bounded buffers),
  zustand stores + ring-buffer/rAF projection utilities. Consumers import
  from `src/lib/index.ts` (the in-app stability barrel).
- `src/islands/{terminal,transcript}/` — **FE-3**; `src/islands/graph/` —
  **FE-4** (M3–M4). Islands self-register through
  `src/chrome/islandRegistry.ts`; chrome never imports island modules.
- `src/features/launch/`, `src/features/observability/` — **FE-5**;
  `src/features/{workstreams,pipelines}/` — **FE-6** (M4–M5).

## Commands

| Command | What |
|---|---|
| `pnpm -F aibender-app test` | vitest (unit + jsdom component + golden-corpus contract suites) |
| `pnpm -F aibender-app test:islands` | Playwright island component tests (FE-3) |
| `pnpm -F aibender-app lint:tokens` / `build:tokens` | token lint / regenerate theme CSS |
| `pnpm -F aibender-app typecheck` | strict tsc over the whole app |
| `pnpm -F aibender-app dev` / `build` | vite SPA (Chrome-as-frontend works against a running core) |
| `pnpm -F aibender-app tauri dev` | the shell (v0 runs `aibender-core` separately — see `src-tauri/README.md`) |
| `pnpm -F aibender-app smoke-test` | headless boot proof (`--smoke-test`, always exits 0) |

The locked exact-pin dependency table in
[frontend-stack-coherence](../docs/research/findings/frontend-stack-coherence.md)
is the list of record — adding a dependency requires an FE-ORCH-approved ADR.
