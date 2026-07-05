# DAG schema contract — the versioned JSON pipeline document (features 4 & 5)

> ## 🔒 FROZEN-M5 v1 — 2026-07-04
> **Owner: BE-ORCH · Co-sign: FE-ORCH.** The harness-owned declarative pipeline
> schema (blueprint §7, plan §4/BE-8, findings
> [pipeline-workflow-builder.md](../research/findings/pipeline-workflow-builder.md)
> §R2/§R3 — Option E). This is the SAVED/EDITED representation the builder UI
> composes, the validator checks, and the runner walks. It is **declarative**
> (GitHub-Actions-shaped `needs:` edges), never imperative JS — native dynamic
> workflows are an INTEROP target (the `workflow-script` step kind), never the
> execution foundation (findings §R4).
>
> After this banner, frozen sections change **only** through an interface change
> request ([docs/contracts/icr/](icr/README.md)): an implementer files
> `icr-NNNN-<slug>.md`, BE-ORCH lands the change, FE-ORCH co-signs.
>
> The machine-checkable half is `packages/protocol/src/dag/` (`DAG_SCHEMA_VERSION
> = 1`; types in `types.ts`, the validator in `validate.ts`, exported through
> the package barrel). **This document is the prose of record when the two
> disagree — file an ICR, never a silent divergence.**

Blueprint anchors: §7 (pipeline engine). Companion contracts: the RUNTIME feed
+ client verbs ride the `pipelines` channel ([ws-protocol.md §18](ws-protocol.md));
the pipeline store + memoization journal is [sqlite-ddl.md §10](sqlite-ddl.md)
(migration 0004); approval gates ride the EXISTING approvals channel via the
frozen `workflow-gate` source ([ws-protocol.md §10.1](ws-protocol.md)).

---

## 1. Document shape — FROZEN (M5 v1)

A pipeline is one JSON object. [X2]: it carries file paths + step ids +
placeholder account labels + prompt/skill/agent **names** ONLY — never real
emails, account ids, or tokens (the brief/catalog discipline; enforced by the
validator's naming screen and the fixture policy).

```jsonc
{
  "schemaVersion": 1,                 // frozen at 1; unknown versions REFUSED (§4)
  "id": "wf_<ulid>",                  // harness-minted; [A-Za-z0-9_-]{1,128}
  "name": "auth-audit",               // identifier-free display name, non-empty [X2]
  "description": "…",                 // optional, identity-screened
  "defaults": {                        // optional; applied to executable steps that omit them
    "account": "MAX_A",               // MAX_A|MAX_B|ENT|AWS_DEV|LOCAL [X2]
    "backend": "claude",              // optional override; consistent with account (§3)
    "permissionMode": "default",      // default|acceptEdits|plan|bypassPermissions
    "cwd": "${workspace}"             // absolute path or ${template}
  },
  "inputs": {                          // optional; name → JSON-schema fragment
    "paths": { "type": "array", "items": { "type": "string" } }
  },
  "steps": [ … ]                       // non-empty; a valid DAG (§4)
}
```

`id` / step-id / input-name charsets are frozen: document id
`[A-Za-z0-9_-]{1,128}`; step id `[A-Za-z0-9_-]{1,64}` (template- and
journal-key-safe); input name `[A-Za-z0-9_-]{1,64}`.

## 2. Step kinds — FROZEN (M5 v1)

`STEP_KINDS` (closed): the four EXECUTABLE kinds + the first-class gate.

| `kind` | Runs | Required fields | Notes |
|---|---|---|---|
| `prompt` | one SDK/OpenCode/LM-Studio call | `prompt` (non-empty) | free-text; templating legal |
| `skill` | a catalog skill/command by name | `skill: {name, scope?, args?}` | `/name args`; optional extra `prompt` |
| `agent` | a catalog subagent by name | `agent: {name, scope?, args?}` + `prompt` | task prompt handed to the agent |
| `workflow-script` | a native dynamic-workflow script (INTEROP) | `scriptPath` (absolute) | STATICALLY referenced, never inlined; run via the SDK on ONE account (findings §1.5/§R4) |
| `approval` | a HUMAN GATE — the engine pauses, the FE prompts the owner | — | `summary?`, `timeoutSec?`, `onTimeout ∈ fail\|continue`; the differentiator no native runtime offers |

**Executable step common fields** (all optional):
`needs`, `when`, `forEach`+`maxParallel`, `loop`, `account`, `backend`, `cwd`,
`permissionMode`, `budget`, `retry`, `outputSchema`, `onError`. The `approval`
step carries only the control fields (`needs`/`when`/`forEach`/`loop`) plus its
own `summary`/`timeoutSec`/`onTimeout` — it spawns no session and takes no
account/budget.

**Control semantics** (findings §R2/§R3):

- **`needs: [stepId…]`** — the DAG edges (GitHub-Actions style); parallel = same
  generation. Every listed id must exist (§4 dangling-needs).
- **`when`** — a template expression; the step is SKIPPED when it evaluates
  falsy (conditional edge).
- **`forEach`** + **`maxParallel`** (1..16, the native concurrency cap) — matrix
  fan-out: the step runs once per element of the resolved array (`${item}` in the
  body). `maxParallel` is only legal WITH `forEach`.
- **`loop: {until, maxIterations}`** (maxIterations 1..100) — "fix until the
  check passes"; the imperative-loop-as-explicit-step discipline (NEVER free-form
  JS). Mutually exclusive with `forEach`.

**Per-step routing / limits** (executable kinds):

- **`account`** — THE [X1] differentiator: per-step account routing (a step on
  MAX_A while another runs on ENT and a third on AWS_DEV). Placeholder label only.
- **`backend`** — `claude|opencode|bedrock|lmstudio`; optional override,
  validated consistent with `account` (§3).
- **`budget: {usd?, turns?, wallClockSec?}`** — at least one field; the engine
  enforces cumulative cost/turns/wall-clock and aborts on breach with
  process-group reaping (findings §R3). `usd` > 0; `turns`/`wallClockSec`
  positive integers.
- **`retry: {max, backoffSec?, retryOn?}`** — `max` 0..10; `retryOn` a non-empty
  subset of `rate_limit|overloaded|timeout|network`.
- **`outputSchema`** — a JSON-schema object (must carry a string `type`)
  enforced via SDK `structured_output`; outputs are journaled and templated
  (`${steps.<id>.output…}`) into successors — never through the model's context.
- **`onError`** — `fail` (default) | `continue` | `goto:<stepId>` (target must
  exist).

## 3. Account ↔ backend consistency — FROZEN (M5 v1)

`ACCOUNT_STEP_BACKENDS` (mirrors the wire `LABEL_BACKENDS`, expanded so AWS_DEV
admits the explicit Bedrock route it fronts):

| account | legal `backend` |
|---|---|
| MAX_A / MAX_B / ENT | `claude` |
| AWS_DEV | `opencode` · `bedrock` |
| LOCAL | `lmstudio` |

A step (or `defaults`) naming a `backend` inconsistent with its `account` is
`invalid-account`.

## 4. Validation semantics — FROZEN (M5 v1)

`validateDagDocument(value)` is total over `unknown`, never throws, and returns
`{ ok: true, document }` (a sanitized document — unknown keys DROPPED, never
echoed [X2]) or `{ ok: false, issue }` where `issue = { code, message, path }`.
The frozen error classes (`DAG_ISSUE_CODES`):

| Code | Trigger |
|---|---|
| `unsupported-version` | `schemaVersion !== 1` (incl. missing) |
| `unknown-step-kind` | a step `kind` outside `STEP_KINDS` |
| `dangling-needs` | a `needs` / `onError goto:` / target names an absent step |
| `duplicate-step-id` | two steps share an id |
| `cycle` | the `needs:` graph is not a DAG (Kahn topo-sort; self-loops included) |
| `invalid-account` | account label outside the enum, or a backend inconsistent with the account |
| `bad-shape` | field-level (blank id/name, empty steps, forEach+loop both set, `maxParallel` without forEach, out-of-range budget/retry/loop bounds, a naming field carrying an email- or 12-digit-shaped literal [X2], …) |

**Validation ORDER** (each stage's failure is exhaustively tested,
`packages/protocol/src/dag/validate.spec.ts`): (1) object + schemaVersion →
(2) id/name/defaults/inputs shape → (3) per-step id pass (duplicate-step-id +
the id set) → (4) per-step structural validation (unknown-step-kind /
invalid-account / dangling-needs / bad-shape; `needs`/`goto`/`forEach` reference
the id set) → (5) cycle detection over the `needs:` graph.

## 5. Forward-compatibility rule — FROZEN (M5 v1)

The document's `schemaVersion` is `1` at this freeze. A validator MUST **refuse**
a document whose `schemaVersion` is unknown (`unsupported-version`) and MUST
refuse an unknown step `kind` (`unknown-step-kind`). This is the **OPPOSITE** of
the wire channels' forward-tolerant unknown-KIND rule ([ws-protocol.md §13.3 /
§16.1 / §18](ws-protocol.md)): a wire push is fire-and-forget fan-out, safely
ignored; a DAG document is **load-bearing execution state** and (in tests) is
NEVER executed — a silently misparsed newer document is a correctness hazard, not
a tolerable unknown. A future schema version is an ICR that lands a new
`DAG_SCHEMA_VERSION` + the migration path; older harnesses refuse it by design.

## 6. `workflow`-edge lineage seam — FROZEN pin (no new surface)

Findings §R3: "every step attempt = a `session_node`" with `workflow` edges
between a step's node and its successors' nodes; "a pipeline is a workstream
subgraph". The M5 freeze VERIFIED this seam is complete without amendment:

- the `workflow` edge type is in the frozen `SESSION_EDGE_TYPES`
  ([ws-protocol.md §16](ws-protocol.md), migration 0003 CHECK) — a member of the
  set since the M4 freeze;
- the schema accessor (`session_edge` / `lineage.ts` `validateEdgeInput`)
  accepts `workflow`: not `import` (so `from_node` REQUIRED), not `handoff` (no
  mandatory brief), not `continue` (no self-edge) — so a step→successor
  `workflow` edge inserts cleanly;
- the wire `WorkstreamEdgeRecord` validator accepts `edgeType: 'workflow'`.

**Recording path (pin, not an amendment):** the `LineageRecorder` port's
`LineageAction` union (launch/resume/fork/recycle/merge) deliberately has **no
`workflow` variant** — that port is for KERNEL session actions. The pipeline
runner (BE-8) records step-attempt nodes + `workflow` edges DIRECTLY on the
lineage store (`store.lineage.edges.insert({ edgeType: 'workflow',
metadataJson: {runId, fromStep, toStep} })`) and publishes them through the
shared `WorkstreamPublisher` — the same store + wire the recorder uses, no new
port. Per-step cost lands in the events store via the `(backend, raw_ref)`
dedupe key ([sqlite-ddl.md §7.2](sqlite-ddl.md)) with `raw_ref` keyed
`pipeline:<runId>:<stepId>:<iteration>` (distinct iterations are distinct keys;
retry-safe re-ingest dedupes) — verified sufficient at this freeze, no schema
change.

## 7. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | **Initial M5 freeze (v1).** Document shape (§1), step kinds (§2 — prompt·skill·agent·workflow-script·approval), account↔backend consistency (§3), validation semantics (§4 — cycle·unknown-step-kind·dangling-needs·duplicate-step-id·invalid-account·unsupported-version·bad-shape), the forward-INCOMPAT rule (§5 — the opposite of the wire's forward-tolerant unknown-kind rule; a DAG document is load-bearing execution state), the `workflow`-edge lineage seam pin (§6 — verified complete without amendment; the runner records edges directly, not via the LineageRecorder port). Machine-checkable half: `packages/protocol/src/dag/` (`DAG_SCHEMA_VERSION = 1`). FE-ORCH co-sign: **co-signed (M5 review, 2026-07-05)** — the FE builder emits schema-valid DAG documents the frozen validator accepts and blocks cycle/invalid-account/bad-shape client-side (`app/src/features/pipelines/builder.spec.ts`, incl. byte-identity against the validator-canonicalized corpus doc; server stays the authority). | — (the freeze itself; plan §3 dag-schema row) |
