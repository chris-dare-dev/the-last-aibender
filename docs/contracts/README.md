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

Status: **M0 — none of the contract docs exist yet.** `packages/protocol`
carries a pre-freeze first draft of the envelope + channel names; do not build
against it as if frozen.
