# docs/contracts/ — frozen interface specs

Human-readable, versioned contract documents for every surface shared across
departments. A contract is **frozen** at its milestone; after freeze it changes
only through an interface change request (see [icr/](icr/README.md)).

The machine-checkable halves of these contracts live in `packages/protocol`
(types + validation) and `packages/schema` (migrations + accessors); this
directory is the prose of record when the two disagree — file an ICR, never a
silent divergence.

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
