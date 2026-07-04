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

Status: **M2 — `ws-protocol.md` is FROZEN-M2 (full)**, `bootstrap-file.md`
and `hooks-contract.md` are written and FROZEN-M2 (FE-ORCH / SI-ORCH co-signs
pending), `sqlite-ddl.md` remains FROZEN-M1 (kernel slice) — all 2026-07-04.
The machine-checkable half of the WS contract is `packages/protocol@1.0.0`
(`PROTOCOL_FREEZE = 'FROZEN-M2'`) plus the golden corpus in
`packages/testkit` (`GOLDEN_WS_CORPUS_FREEZE`). One recorded deferral: the
`events` channel **payload union** freezes at M3 with BE-5 (ws-protocol.md
§8). `dag-schema.md` does not exist yet (M5). Landed ICRs and the deferred
watch list live in [icr/](icr/README.md).
