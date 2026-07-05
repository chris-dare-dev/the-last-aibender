# the-last-aibender

A personal **multi-account Claude Code harness** for macOS: one host-native
broker daemon (`aibender-core`) drives parallel Claude sessions across multiple
subscription accounts plus Bedrock and local models, with a Tauri cockpit on
top. Built by agents, reviewed by orchestrators, specified by the research
under [`docs/research/`](docs/research/).

> **Identity policy [X2]:** this repo is public. Account identities appear only
> as sanctioned placeholders — Claude Max accounts as the OPEN form **`MAX_<X>`**
> (`^MAX_[A-Z]$`: MAX_A, MAX_B, MAX_C, …), the enterprise account as **ENT**, the
> fixed backend labels **AWS_DEV / LOCAL**, and **AWS_DEV_ACCOUNT_ID** — in code,
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
2. **One-off prompts against a *specified* account** — launch a prompt on any
   provisioned Claude Max account (`MAX_<X>`), ENT, AWS_DEV (Bedrock), or LOCAL,
   explicitly. The account set is an open, validated form (ICR-0013), so adding
   a new Max subscription needs no code change.
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

The **Owner** column names the department/lane that owns the directory (the
exclusive-ownership rule that lets the multi-agent build run in parallel — see
[docs/runbooks/workflow-orchestration.md](docs/runbooks/workflow-orchestration.md)).
The dense full map is plan §2.

| Path | Purpose | Owner |
|---|---|---|
| `packages/` | Shared contract packages: [`protocol`](packages/protocol/) (WS types + validators), [`schema`](packages/schema/) (SQLite migrations + accessors), [`shared`](packages/shared/) (identity map, redaction, logger), [`testkit`](packages/testkit/) (golden corpora + test doubles) | orchestrator-stewarded (BE-ORCH lands, FE-ORCH co-signs) |
| `core/` | `aibender-core` broker daemon: `kernel/` (per-account spawn + resume ledger), `gateway/` (the one multiplexed WS + bootstrap file), `adapters/` (opencode/lmstudio), `collector/`+`readmodels/` (observability), `workstreams/` (X4 lineage), `pipelines/` (DAG engine), `supervision/` (governor), `main/` (`composeBroker`) — see [core/README.md](core/README.md) | Backend (BE) |
| `app/` | Tauri v2 cockpit: `src/chrome/` (shell + panels + palette + inbox), `src/lib/` (WS client, bootstrap reader, stores), `src/islands/{terminal,transcript,graph}/`, `src/features/{launch,observability,workstreams,pipelines}/`, and the FE-ORCH-owned locked theme — see [app/README.md](app/README.md), [DESIGN.md](DESIGN.md) (LOCKED) | Frontend (FE) |
| `infra/` | Server-side config & IaC: `profiles/`+`scripts/` (account provisioning), `launchd/`+`hooks/` (daemon + telemetry), `aws/` (Bedrock IaC, applies hard-gated), `colima/`, `ci/` — see [infra/README.md](infra/README.md) | Server-side infra (SI) |
| `docs/contracts/` | Frozen interface specs + the [ICR process](docs/contracts/icr/README.md) (read [contracts/README.md §0](docs/contracts/README.md) first) | orchestrator-stewarded |
| `docs/adr/` | Deviation records against the blueprint | any lane (owning ORCH signs) |
| `docs/runbooks/` | Operator procedures + per-milestone DoD records — start local dev with [local-dev-start.md](docs/runbooks/local-dev-start.md); the [hygiene gate](docs/runbooks/hygiene.md) is live | SI (most), owning lane per topic |
| `spikes/` | M0 risk-spike harnesses — [quarantined](spikes/README.md), never imported by prod code | M0 (frozen) |
| `var/` | gitignored dev-mode runtime data | — |

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

**To run the harness locally** (start a broker + the app and watch it render):
[docs/runbooks/local-dev-start.md](docs/runbooks/local-dev-start.md) — the single
cold-start guide.

**Building on this repo as a multi-agent collaborator?** Read
[docs/HANDOFF.md](docs/HANDOFF.md) first, then its companion
[docs/runbooks/workflow-orchestration.md](docs/runbooks/workflow-orchestration.md)
— the reusable Workflow pattern (department ownership, ICRs, the Freeze→Build→
Review→Fix→Gate shape) that drove every milestone.
