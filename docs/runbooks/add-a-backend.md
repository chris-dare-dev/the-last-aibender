# Runbook — add a new local LLM / backend

**Status:** live (Stage 3, SI) · **Audience:** engineer (register a descriptor) +
owner (a live health run is T3, real host)
**Sources of record:** ICR-0016
([../contracts/icr/icr-0016-backend-registry.md](../contracts/icr/icr-0016-backend-registry.md)),
`docs/contracts/ws-protocol.md` §4.1 (backend vocabulary) and
`docs/contracts/sqlite-ddl.md` §10.8 (backend-CHECK-derivation decision); the
registry itself is `packages/protocol/src/vocab.ts` (`BackendDescriptor`,
`registerBackend`, `backendById`, `allBackends`). Companion record:
[account-registry.md](account-registry.md) is the [X1] account twin of this
same generalization; [add-an-account.md](add-an-account.md) is its operator
procedure and the shape this runbook mirrors.

This is the **OS-1 scalability answer made concrete**: "is it easy to add a new
local LLM / backend beyond the built-in three?" — **yes**. Before ICR-0016 the
answer was *no*: `BACKENDS` was a frozen 3-tuple (`claude_code`, `opencode`,
`lmstudio`), `backendForLabel` was a hardcoded if-chain, those three literals
were branched at ~42 non-spec files, and every schema migration hardcoded a
`CHECK` that `backend` was one of the three. Adding a fourth was a
cross-codebase fork. Now adding a backend is **one `BackendDescriptor` + one
`registerBackend` call at the composition root**, plus wiring its adapter — **no
migration, no vocab edit, no ~42-site branch fork**. The three built-ins behave
**byte-identically** to before; a registered fourth routes end-to-end through
the same registry seams with no literal edits.

[X2] reminder: a backend `id` is a **generic identifier**, not a secret and not
an account (`ollama`, `vllm`, `llamacpp` are fine placeholders). Never encode a
real endpoint, token, org id, or AWS account id in the descriptor, its config
entry, or this runbook — those live machine-locally under `$AIBENDER_HOME/` and
the Keychain, exactly as for accounts. The pre-commit gitleaks gate enforces it;
never bypass.

---

## Two concepts, kept separate (read this first)

A backend is **not** an account. The registry generalization keeps the same
split ICR-0013 drew for accounts:

- **A backend** is an execution *substrate* — a new local LLM server, a new
  supervised CLI, a new API. It carries an `id` (`session_node.backend`,
  `events.backend`), the events `source` it feeds, and the substrates it may run
  on. You add one with the procedure below.
- **A Claude subscription account** is a `MAX_<X>`/`ENT` label on the
  `claude_code` backend. You add one with [add-an-account.md](add-an-account.md)
  — a manifest-only change, no descriptor.

The two **fixed backend labels** `AWS_DEV` and `LOCAL` are the account-label
stand-ins for the two built-in *non-Claude* backends (`AWS_DEV` → `opencode`,
`LOCAL` → `lmstudio`). They stay closed. A new backend does **not** get a new
fixed backend label bolted onto the closed set — it declares its **own**
account-label form in its descriptor's `servesLabel` predicate, and
`registerBackend` **refuses** a descriptor whose `servesLabel` overlaps any
built-in label (`MAX_<X>`, `ENT`, `AWS_DEV`, `LOCAL`), so a fourth backend can
never hijack a built-in.

---

## The whole procedure (one descriptor, one registration, one adapter)

### 1. Write the `BackendDescriptor` (the data change)

Everything the cross-codebase dispatch needs to route a backend lives in one
descriptor (`packages/protocol/src/vocab.ts` `BackendDescriptor`). Pick a
generic `id` — say `ollama` — and declare the five required fields (+ the two
optional adapter/probe keys):

```ts
import type { BackendDescriptor } from '@aibender/protocol';

export const OLLAMA_BACKEND: BackendDescriptor = {
  id: 'ollama',                               // wire/DB backend literal; unique
  servesLabel: (label) => label === 'OLLAMA', // ITS account-label form — must
                                              // NOT overlap MAX_<X>/ENT/AWS_DEV/LOCAL
  sourceName: 'lmstudio',                     // an EXISTING EVENT_SOURCES value (see
                                              // the sourceName caveat below) — the
                                              // events pane attributes steps to it
  substrates: ['sdk'],                        // 'sdk' and/or 'pty'; pty is Claude-only
  builtin: false,                             // registered backends are never builtin
  adapterFactoryKey: 'ollama',                // OPTIONAL: stable key the core root
  healthProbeKey: 'ollama',                   //           maps to the concrete factory/probe
};
```

> **`sourceName` caveat — the one thing that is NOT free.** The events-store
> `source` vocabulary (`EVENT_SOURCES` in `packages/protocol/src/events.ts`) is a
> **closed** registry, and the events accessor's insert path gates on
> `isEventSource(source)` (a closed-array membership check that does **not**
> consult the backend registry). So `sourceName` **must be one of the existing
> `EVENT_SOURCES` literals** (`claude-jsonl`, `claude-otel`, `claude-quota`,
> `hooks`, `opencode-sse`, `opencode-db`, `bedrock-cost-explorer`,
> `bedrock-cloudwatch`, `lmstudio`, `ent-analytics`). A local-LLM backend that
> feeds inline usage like LM Studio can reuse `'lmstudio'` (or the nearest
> matching feed). **Introducing a genuinely new `source` VALUE is a separate
> events-vocabulary change — its own ICR** ("EVENT_SOURCES is a closed registry —
> growing it is an ICR"). ICR-0016 opened the backend *id* and the DB `source`
> `CHECK` (migration 0008 relaxed it to `length(source) > 0`), but the app-layer
> `isEventSource` gate was intentionally left closed, so a new backend routes
> end-to-end **only** when its `sourceName` is an admitted source. This keeps the
> events pane's freshness axis and the [X2] audit source list truthful.

Field-by-field, and the invariant `registerBackend` enforces for each:

| Field | What it is | Invariant enforced |
|---|---|---|
| `id` | The wire/DB backend literal (`session_node.backend`, `events.backend`). | Non-empty string, **unique** in the registry; may not be a built-in id (`claude_code`/`opencode`/`lmstudio`); a conflicting id already bound to a *different* descriptor is refused (re-registering the *same* descriptor object is idempotent). |
| `servesLabel(label)` | The account-label predicate — the **backend side** of the label↔backend pairing. Any label for which it returns `true` pairs with this `id` in `backendForLabel`. | Must be a function; **must not overlap any built-in label form**. `registerBackend` probes `MAX_A`, `MAX_Z`, `ENT`, `AWS_DEV`, `LOCAL` against your predicate and refuses on any overlap — so you cannot hijack a Claude/OpenCode/LM-Studio label. |
| `sourceName` | The events-store `source` a step on this backend feeds (the `sourceForBackend` resolution — keeps the events pane truthful). | Non-empty string, **and one of the existing `EVENT_SOURCES` literals** — the app-layer `isEventSource` gate stays closed (see the caveat above). A new `source` value is its own ICR. |
| `substrates` | Legal execution substrates — `['sdk']`, `['pty']`, or both. | Must be an array; each entry must be a known substrate (`sdk`/`pty`). `pty` is the attended surface and is **Claude-only** by blueprint §4.1 — a non-Claude backend that lists `pty` will be routable by `substrateLegalFor` but the pty host itself still refuses non-`claude_code` attach, so declare `['sdk']` unless you genuinely mean attended. |
| `builtin` | `true` only for the three seed backends. | A descriptor flagged `builtin: true` is **refused** — the built-ins are pre-seeded; yours is always `false`. |
| `adapterFactoryKey?` | OPTIONAL stable key the **core composition root** maps to the concrete adapter factory. | The protocol package is dependency-free and holds no live adapter, so a descriptor names *which* adapter it wants by a stable key rather than carrying one. §3 below is the adapter-factory contract. |
| `healthProbeKey?` | OPTIONAL stable key mapped to the concrete health probe. | Same indirection as `adapterFactoryKey`. §4 below is the health-probe contract. |

No `BACKENDS` array edit, no `Backend` type edit, no `backendForLabel`/
`sourceForBackend` branch edit — those resolve through the registry now. The
`Backend` *type* stays the seed union of the three built-ins for compile-time
exhaustiveness at the built-in call sites; your registered id is a `BackendId`
(a widened `string`) at runtime, and `isBackend`/`backendForLabel`/
`sourceForBackend`/`substrateLegalFor` all admit it.

### 2. Register it at the composition root (the one wiring line)

`registerBackend` is the single seam a new-backend author touches for the
vocabulary side. Call it once at boot, before the broker discovers backends:

```ts
import { registerBackend } from '@aibender/protocol';
import { OLLAMA_BACKEND } from './backends/ollama.js';

registerBackend(OLLAMA_BACKEND);
```

After this call the registry has widened everywhere at once:

- `isBackend('ollama')` → `true` (wire validator + schema accessor admit it);
- `backendForLabel('OLLAMA')` → `'ollama'` (built-in labels still resolve
  FIRST and verbatim, so a descriptor can never shadow a built-in);
- `isAccountLabel('OLLAMA')` → `true` (a label served by a registered backend);
- `sourceForBackend('ollama')` → `'lmstudio'` (the events pane attributes its
  steps to the `lmstudio` source, matching the descriptor's `sourceName` above);
- `substrateLegalFor('sdk', 'ollama')` → `true`, `substrateLegalFor('pty',
  'ollama')` → `false` (the registry form of the pty-is-Claude-only rule);
- `allBackends()` enumerates it (built-ins first, then registered additions in
  registration order) — so the launch picker, channel panels, and observability
  chips render it from the registry, not a hardcoded three.

`registerBackend` throws a typed `BackendRegistrationError` on a malformed
descriptor, a built-in id, a conflicting id, an unknown substrate, or a
built-in-label overlap — the failure is loud, at boot, never silent.

> **Test/teardown hygiene.** A spec that registers a synthetic backend must
> `unregisterBackend(id)` in cleanup so the registry does not leak across specs.
> The three built-ins may never be unregistered.

### 3. The adapter-factory contract

A descriptor declares *intent* (`adapterFactoryKey`); the **core composition
root** (not the protocol package) maps that key to a concrete adapter factory.
The three built-in adapters live in `core/src/adapters/` and are the shape to
mirror:

- `core/src/adapters/opencode/` — a supervised `opencode serve` + SSE transport
  + SDK client + guarded read-only db access;
- `core/src/adapters/lmstudio/` — `/v1` inference routing, lifecycle, residency;
- `core/src/adapters/claude-sdk/` — a thin wrapper over the kernel QueryRunner.

The contract your factory honours (mirroring `core/src/adapters/index.ts`):

1. **Every live side effect sits behind an explicit opt-in flag with a typed
   refusal.** A serve spawn, a Keychain read, a CLI invocation — none happens by
   accident in tests or by default composition. This is what lets the whole
   suite run hermetically and lets `live-check.sh` gate the real thing behind a
   T3 owner run.
2. **The factory is constructed, not imported for effect.** The composition root
   builds it and injects it into the broker's adapter fan-out; nothing in
   `packages/*` ever holds a live adapter (the protocol package must stay
   dependency-free — that is *why* the descriptor carries a `key`, not a
   factory).
3. **`core/` imports nothing from `infra/`** (enforced by the architectural
   test). Your adapter's config comes from the bootstrap/env surface, not from
   reaching into `infra/`.

> **Ownership note.** Authoring the adapter factory and the composition-root
> `key → factory` map is a **core/BE-lane** job, not an infra one. This runbook
> documents the *contract* so an operator/engineer knows exactly what a new
> backend must provide; the wiring lands in `core/src/adapters/<id>/` and the
> composition root under that lane's ownership.

### 4. The health-probe contract

A backend's reachability is a **first-class state**, never an error toast — a
down local server renders a dimmed "NO SIGNAL" instrument. Mirror the built-in
LM Studio probe (`core/src/adapters/lmstudio/health.ts`):

```ts
export interface BackendHealthProbe {
  check(): Promise<BackendHealth>;   // NEVER throws for a down server —
}                                     // "down" is a value, not an exception
```

- Use a **short** timeout (the LM Studio default is 750 ms) so the down path can
  never hang a caller.
- Return a discriminated result — `{ state: 'up', … }` or `{ state: 'down',
  reason }` — that the freshness state machine (`core/src/readmodels/`) consumes
  verbatim.
- Bind to **127.0.0.1** by construction ([X3] host-native residency); a local
  backend is not exposed off-loopback.

The operator-facing side of this is one `live-check.sh` probe entry (§5).

### 5. Operator health check (T3, real host)

The T3 milestone-gate runner (`infra/ci/live-check.sh`) probes each concrete
substrate by name — today `lmstudio-probe` and `opencode-serve-probe`. A new
backend adds **one probe entry** in the same shape (`name|milestone|
description|source-of-record`) and one `check_<name>()` function that:

- never auto-starts the backend (a down server is a first-class `SKIP`, not a
  `FAIL`);
- talks health/list/read-only endpoints **only** — never a message/completion
  call that would incur cost;
- honours the offline kill-switch (`AIBENDER_LIVECHECK_OFFLINE=1` → `SKIP` with
  a pending-owner note);
- kills any temporary server it started on exit.

If you add such a probe, add a bats case for it under `infra/ci/tests/`
following the existing `opencode probe FAILs when serve never becomes healthy` /
`offline kill-switch provably prevents spawning` pattern, and keep
`infra/ci/tests/run.sh` green.

### 6. No migration needed (the key OS-1 proof)

**You do not write a schema migration for a new backend.** This is the crux of
the OS-1 fix. A SQLite `CHECK` is static SQL and cannot query the runtime
registry, so migrations **0007** (kernel DB) + **0008** (events DB) already
relaxed the `backend` clauses so a registered backend lands with **no schema
change**:

- `backend` → `length(backend) > 0` (open, non-empty) — the *value* set moved to
  the **app layer**, where the registry-driven `isBackend()` screens it at
  insert, exactly as M3 did for the open `event_type`/`model`/`provider`
  vocabularies;
- the account, pairing, and pty `CHECK`s became "the built-in clauses hold for
  the built-in backends, OR the backend is **not** one of the three built-ins
  (defer to the app layer)". So a row for a registered backend with a
  non-built-in account label passes the DB `CHECK` and is gated by the
  accessor's `isAccountLabel()`/`backendForLabel()`/`substrateLegalFor()`;
- the built-in clauses stay `CHECK`-enforced (defense-in-depth) **byte-identical**
  — a bypassing raw-SQL writer still cannot land an illegal *built-in* row.

The M7 open `MAX_<X>` account form is a strict **subset** of what the relaxed
`CHECK` admits, so every M1–M7 row still validates. See `sqlite-ddl.md` §10.8.

### Done

The new backend is a first-class registry member: it validates on the wire and
at the schema accessor, pairs with its own account-label form, feeds its own
events `source`, enumerates in `allBackends()` (so the FE renders it), and runs
concurrently alongside the built-in three. **No `vocab.ts` literal, no `Backend`
type, no ~42-site branch, and no migration were changed** — you added one
descriptor, one `registerBackend` call, one adapter, and one health probe.

---

## Removing a backend

Call `unregisterBackend(id)` (never for a built-in — those refuse), remove its
composition-root registration + adapter factory + `live-check.sh` probe entry,
and delete any machine-local config under `$AIBENDER_HOME/`. Rows already
written for that backend stay valid (the relaxed `CHECK` still admits a
non-empty `backend`), so no down-migration is needed; the read models simply
stop enumerating it once `allBackends()` no longer returns it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `registerBackend` throws `BackendRegistrationError: … servesLabel overlaps built-in label MAX_A` | Your `servesLabel` matches a Claude/OpenCode/LM-Studio label | Narrow the predicate to your own label form; a descriptor may never claim a built-in label |
| `registerBackend` throws `cannot register a descriptor flagged builtin` | `builtin: true` on your descriptor | Set `builtin: false` — only the three seed descriptors are builtin |
| `registerBackend` throws `cannot re-register the built-in backend id …` | Your `id` is `claude_code`/`opencode`/`lmstudio` | Pick a distinct generic id |
| `isBackend('yourid')` is false at runtime | `registerBackend` was never called (or called after backend discovery) | Register at the composition root **before** the broker enumerates backends |
| A row for your backend is refused by the DB | You wrote it before migration 0007/0008 ran, or `backend` was empty | Ensure the DB is migrated to ddl_version ≥ 7 / events ≥ 8; `backend` must be non-empty |
| `sourceForBackend('yourid')` throws `UnknownBackendError` | Backend not registered when the events pane resolved its source | Register before the collector starts; gate with `isBackend` first |
| The launch picker doesn't show your backend | The FE enumerates `allBackends()`; the descriptor isn't registered at boot | Register in the composition root that the FE bootstrap observes |

## T3 pending-owner checklist (real host, real backend)

- [ ] `BackendDescriptor` authored + `registerBackend` called at the composition root
- [ ] Adapter factory built under `core/src/adapters/<id>/`, all live side effects flag-gated
- [ ] Health probe built (short timeout, down-as-value, 127.0.0.1)
- [ ] `live-check.sh` probe entry + `check_<id>()` added; bats case green; `infra/ci/tests/run.sh` passes
- [ ] Real backend reachable on 127.0.0.1 → probe `PASS` (offline → honest `SKIP`)
- [ ] A launch on the new backend routes end-to-end (spawn → events `source` → picker chip) with **no** vocab/migration edit
