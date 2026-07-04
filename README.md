# the-last-aibender

A personal **multi-account Claude Code harness** for macOS: one host-native
broker daemon (`aibender-core`) drives parallel Claude sessions across multiple
subscription accounts plus Bedrock and local models, with a Tauri cockpit on
top. Built by agents, reviewed by orchestrators, specified by the research
under [`docs/research/`](docs/research/).

> **Identity policy [X2]:** this repo is public. Account identities appear only
> as the placeholders **MAX_A / MAX_B / ENT / AWS_DEV_ACCOUNT_ID** — in code,
> tests, fixtures, docs, and every stored row. Real mappings live machine-local
> under `~/.aibender/`, never in the tree. See [SECURITY.md](SECURITY.md).

## Status: M0 — scaffold

Monorepo skeleton + hygiene gate. No broker logic and no infra IaC yet. On the
UI side, the FE-1 design system landed: [DESIGN.md](DESIGN.md) is **AUTHORED**
(awaiting the FE-ORCH lock mark) and its theme/token chain lives under
`app/src/chrome/theme/` with tests; all other FE packages stay gated until the
lock. The normative specs are:

- [00 · Executive summary](docs/research/summaries/00-executive-summary.md) — Stage-1 research narrative
- [01 · Architecture blueprint](docs/research/summaries/01-architecture-blueprint.md) — **normative**; deviations require an [ADR](docs/adr/README.md)
- [02 · Stage-2 implementation plan](docs/research/summaries/02-stage2-implementation-plan.md) — departments, work packages, milestones M0–M6

## The six product features (v0 target)

1. **Usage & cost observability** — per-account 5h/weekly quota gauges with
   reset countdowns, burn rate, Bedrock actual-vs-estimate USD, cache hit
   rates, latency, skill leaderboard — one SQLite events store behind it all.
2. **One-off prompts against a *specified* account** — launch a prompt on
   MAX_A, MAX_B, ENT, AWS_DEV (Bedrock), or LOCAL, explicitly.
3. **Skill launches from a specified account** — `/skill-name args` composition
   with a catalog-driven picker.
4. **Multi-agent workflows with per-step account/Bedrock routing** — a
   harness-owned JSON DAG engine with approval gates, budgets, and a durable
   memoization journal.
5. **Workspace-scoped pipeline builder** — one capability-catalog scanner
   (skills, commands, agents, plugins, OpenCode capabilities) feeding a
   builder UI.
6. **Live context graph** — a real-time graph of sessions, files, and artifacts
   rendered in a WebGL island.

## Cross-cutting requirements

- **[X1] Parallel multi-account** — per-account `CLAUDE_CONFIG_DIR` + pinned
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`; one broker, three accounts, zero re-login.
- **[X2] Public-repo secret hygiene** — placeholders only; two-tier gitleaks
  (committed rules are value-free) + CI backstop; synthesized fixtures only.
- **[X3] Virtualization verdict: PARTIAL** — harness core fully host-native;
  k3s-in-Colima demoted to an optional telemetry adjunct, never a dependency.
- **[X4] Workstreams** — a harness-owned SQLite lineage ledger; typed edges
  recorded at action time; continuation = child; merge = synthesized brief.

## Repository layout (plan §2)

| Path | What lives there |
|---|---|
| `packages/` | Shared contract packages: [`protocol`](packages/protocol/), [`schema`](packages/schema/), [`shared`](packages/shared/), [`testkit`](packages/testkit/) — stubs at M0, frozen per milestone |
| `core/` | `aibender-core` broker daemon (Backend dept) — M0: placeholder entry point |
| `app/` | Tauri v2 app (Frontend dept) — FE-1 theme/token chain landed ([DESIGN.md](DESIGN.md) AUTHORED); **all other FE surface gated until FE-ORCH locks DESIGN.md** (FE-1 gate) |
| `infra/` | Server-side config & IaC (SI dept) — see [infra/README.md](infra/README.md); AWS applies are hard-gated |
| `docs/contracts/` | Frozen interface specs + [ICR process](docs/contracts/icr/README.md) |
| `docs/adr/` | Deviation records against the blueprint |
| `docs/runbooks/` | Operator procedures ([hygiene gate](docs/runbooks/hygiene.md) is live) |
| `spikes/` | M0 risk-spike harnesses — [quarantined](spikes/README.md), never imported by prod code |
| `var/` | gitignored dev-mode runtime data |

## Getting started (development)

Requires Node ≥ 22 and pnpm 11.

```bash
pnpm install
pnpm test        # one vitest workspace run across all packages
pnpm -r test     # or: each package's own suite
pnpm typecheck   # strict TS 5 across the workspace
```

Committing requires the hygiene gate: `infra/scripts/install-hooks.sh`, then
follow [docs/runbooks/hygiene.md](docs/runbooks/hygiene.md) — the pre-commit
hook **fails closed** until the machine-local Tier-2 config exists.
