# app/ — Tauri v2 application (FRONTEND department)

**Gate state (plan §5, package FE-1):** `DESIGN.md` exists at the repo root
(status: AUTHORED — awaiting the FE-ORCH lock mark) and FE-1's theme/token
chain has landed in this directory:

- `src/chrome/theme/` — **FE-ORCH-owned** token source of truth:
  `tokens.ts` → generated `tokens.css` + `tailwind.theme.css`
  (`pnpm -F aibender-app build:tokens`; drift-guarded by `theme.spec.ts`).
- `scripts/lint-tokens.mjs` — the mechanical FORBIDDEN-list enforcement
  (`pnpm -F aibender-app lint:tokens`; DESIGN.md §8.3).

**FE-2…FE-6 remain GATED: no other FE package may merge UI code into this
directory until FE-ORCH marks DESIGN.md LOCKED.** Until then, the FE-1 chain
above is the only code that belongs here.

Once the gate lifts, FE-A…FE-D fill `src-tauri/`, the rest of `src/chrome/`,
`src/lib/`, `src/islands/{terminal,transcript,graph}/`, and `src/features/*`
per plan §2/§5. The locked exact-pin dependency table in
[frontend-stack-coherence](../docs/research/findings/frontend-stack-coherence.md)
is the list of record — adding a dependency requires an FE-ORCH-approved ADR.
