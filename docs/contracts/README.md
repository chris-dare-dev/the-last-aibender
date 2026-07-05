# docs/contracts/ — frozen interface specs

Human-readable, versioned contract documents for every surface shared across
departments. A contract is **frozen** at its milestone; after freeze it changes
only through an interface change request (see [icr/](icr/README.md)).

The machine-checkable halves of these contracts live in `packages/protocol`
(types + validation) and `packages/schema` (migrations + accessors); this
directory is the prose of record when the two disagree — file an ICR, never a
silent divergence.

## §0 — How to read these contracts (start here)

Each contract has **three halves that must agree**, and knowing which to open
saves you from hunting:

1. **The prose (this directory)** is *normative for decisions and
   cross-department coordination* — what a surface means, why it is shaped that
   way, and what the freeze/amendment rules are. When code and prose disagree,
   **the prose is the record**; you reconcile by filing an ICR, never by
   silently editing one side.
2. **The code (`packages/protocol`, `packages/schema`)** is *the authority for
   validation and serialization* — the TypeScript types, the total validators
   (`isX`/`validateX`), the DDL migrations, and the accessors. This is what
   actually runs; if you need to know exactly what shape passes the wire or the
   CHECK constraint, read the code, not the prose.
3. **The testkit golden corpora (`packages/testkit`)** are *the proof of
   conformance* — a frozen set of valid and every-invalid-class fixtures
   (`GOLDEN_WS_FIXTURES`, `GOLDEN_HOOK_FIXTURES`, etc., tagged
   `GOLDEN_WS_CORPUS_FREEZE` / `GOLDEN_HOOK_CORPUS_FREEZE`). Both the broker and
   the FE replay the SAME corpus, which is what keeps the two department halves
   honest to one contract.

**`FROZEN-M<n>`** on a contract means: it was locked at milestone `n` and, after
that banner, changes **only** through the ICR/co-sign process below. The
per-contract **amendment table** at the bottom of each doc is the audit trail —
every post-freeze change is one dated row citing its ICR. If a doc carries
several `FROZEN-M<n>` banners (e.g. `ws-protocol.md`), each records the additive
freeze at that milestone; the newest is the current state, the older ones are
history kept for readers.

**The ICR / co-sign loop** (full detail in [icr/README.md](icr/README.md)): an
implementer writes `icr/icr-NNNN-<slug>.md`; the **owning orchestrator**
(BE-ORCH for `protocol`/`schema`) reviews and lands it — implementers never
commit to a frozen surface directly; if another department consumes the surface,
the **counterpart orchestrator co-signs** before it lands (e.g. FE-ORCH for a
protocol change the cockpit reads).

**Worked example** — you are handed "land the BE-8 DAG schema." The trail is:

```
docs/contracts/dag-schema.md          ← prose: step kinds, needs/when/forEach, freeze rule (READ FIRST)
packages/protocol/src/dag/            ← code: the types + validators that actually enforce it
packages/testkit  (GOLDEN_WS_FIXTURES)← proof: valid + every-invalid-class fixtures, replayed both sides
```

A shorter one for the WS envelope: `ws-protocol.md §2 (Envelope)` →
`packages/protocol/src/envelope.ts` → the `ws-*` fixtures in `packages/testkit`.
Go straight to the code + fixtures for the machine-checkable half; use the prose
for the "why" and the freeze/amendment rules.

## §0.1 — Protocol version numbering & freeze cadence (for maintainers)

`packages/protocol` carries a single semver `PROTOCOL_VERSION` and a
`PROTOCOL_FREEZE = 'FROZEN-M<n>'` tag. When you finish a surface change and must
decide the bump, the **rule of record** is:

- **MAJOR** — a backward-incompatible **shape** change: a field's type changes,
  a required field is added/removed, an existing frame is re-shaped. A reader
  built for the old version can no longer parse the new. (None has occurred; the
  protocol has only ever widened.)
- **MINOR** — **validation-widening** or **additive** surface: a new channel, a
  new optional field, a new read-model kind, a relaxed validator that still
  accepts every previously-valid value. Old readers keep working
  (forward-tolerant unknown-kind rule); new capability is available. *This is
  the common case.*
- **PATCH** — a **clarification** with no wire/behavior change: prose tightening,
  a comment, a doc-only pin.

**Freeze cadence:** every milestone that touches a shared surface ends in a
freeze — the contract's `FROZEN-M<n>` banner advances, `PROTOCOL_FREEZE`
advances in lockstep, the golden corpus is re-tagged, and the change is recorded
as a dated row in the doc's amendment table. **Every freeze is tagged and
recorded in prose**; there is no untracked protocol change.

**Worked example (the M7 account-registry widening, ICR-0013).** The closed
5-label account set became the OPEN validated FORM (`^MAX_[A-Z]$` + `ENT`), so a
newly provisioned `MAX_C`/`MAX_D` is admitted with no code change. Every M1–M6
label is still valid and **no wire shape changed** — this is validation-widening,
not a shape break — so it was a **minor** bump: `1.4.0 → 1.5.0`,
`FROZEN-M6 → FROZEN-M7`. Contrast the M6 `resource-health` read-model (a genuinely
new but additive frame on a closed registry): also minor, `1.3.0 → 1.4.0`. The
rule lives inline in `packages/protocol/src/index.ts` TSDoc as well, on each
freeze block — but this is the canonical statement of the principle.

## Contract index

| Contract | Content | Owner | Freeze |
|---|---|---|---|
| `ws-protocol.md` | WS envelope, channels, binary PTY frames, ack-watermark flow control, error envelope | BE-ORCH (FE-ORCH co-signs) | M1 core, M2 full |
| `sqlite-ddl.md` | All ledgers + events store DDL | BE-ORCH | M1, amended per milestone |
| `hooks-contract.md` | http-hook payloads the collector accepts | BE-ORCH + SI-ORCH | M2 |
| `bootstrap-file.md` | Gateway port/token discovery file format | BE-ORCH + FE-ORCH | M2 |
| `dag-schema.md` | Pipeline JSON DAG v1 | BE-ORCH | M5 |
| `integration-suite.md` | §9.3/§9.4 cross-department integration-suite contract of record | BE-ORCH (FE/SI co-sign seams) | M6 |

Status: **M6 (FINAL Stage-2 freeze) — `ws-protocol.md` is FROZEN-M6** (M3
closed the `events` union §13; M4 added the `workstream` channel §16 + the
lineage seams §15; M5 added the `pipelines` channel §18; **M6 added the
eleventh read model `resource-health` §13.4** — the supervision/governor
instrument, blueprint §11, on the existing `events` channel), `sqlite-ddl.md`
carries four frozen slices (M1 kernel §1–§5, M3 events §7, M4 lineage §8, M5
pipelines §10) **unchanged at M6** (read models are computed live — no DDL
companion), `dag-schema.md` is **FROZEN-M5 v1** (unchanged at M6),
`hooks-contract.md` is FROZEN-M2 with the M3 acceptance types (§7) and the M4
[X4] routing (§7.1) **unchanged at M6**, `bootstrap-file.md` is FROZEN-M2
**unchanged at M6**, `integration-suite.md` is the **FROZEN-M6** §9.3/§9.4
contract-of-record note. The machine-checkable half of the WS + DAG contracts
is `PROTOCOL_VERSION 1.4.0` (`PROTOCOL_FREEZE = 'FROZEN-M6'`;
`DAG_SCHEMA_VERSION 1`, unchanged) plus the golden corpora in
`packages/testkit` (`GOLDEN_WS_CORPUS_FREEZE` / `GOLDEN_HOOK_CORPUS_FREEZE`,
both advanced to `FROZEN-M6`). No open deferrals. Landed ICRs and the deferred
watch list live in [icr/](icr/README.md).
