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

Status: **M4 — `ws-protocol.md` is FROZEN-M4** (M3 closed the `events`
union §13; M4 added the `workstream` channel §16 + the lineage seams §15),
`sqlite-ddl.md` carries three frozen slices (M1 kernel §1–§5, M3 events §7,
M4 lineage §8), `hooks-contract.md` is FROZEN-M2 with the M3 acceptance
types (§7) and the M4 [X4] routing (§7.1), `bootstrap-file.md` is FROZEN-M2
— all 2026-07-04 (FE-ORCH / SI-ORCH co-signs pending per the amendment
tables). The machine-checkable half of the WS contract is
`PROTOCOL_VERSION 1.2.0` (`PROTOCOL_FREEZE = 'FROZEN-M4'`) plus the golden
corpora in `packages/testkit` (`GOLDEN_WS_CORPUS_FREEZE` /
`GOLDEN_HOOK_CORPUS_FREEZE`). No open deferrals. `dag-schema.md` does not
exist yet (M5). Landed ICRs and the deferred watch list live in
[icr/](icr/README.md).
