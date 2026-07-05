# Bootstrap file contract — gateway port/token discovery

> ## 🔒 FROZEN-M2 — 2026-07-04
> **Owner: BE-ORCH · Co-sign: FE-ORCH.** After this banner, this contract
> changes **only** through an interface change request
> ([docs/contracts/icr/](icr/README.md)). This document **codifies the M1
> gateway implementation** (`core/src/gateway/bootstrap.ts`, landed with BE-3's
> M1 slice and exercised by `bootstrap.spec.ts` / `server.spec.ts` /
> `main/index.spec.ts`) — the code shipped first, the prose freezes what it
> does. **This document is the prose of record when the two disagree — file an
> ICR, never a silent divergence.**

Blueprint anchors: §2 (one multiplexed WS on `ws://127.0.0.1:<port>`; the
frontend discovers the broker, never configures it), plan §6/SI↔FE #1 (Tauri
cold-start discovers port/token via this contract on a clean user account),
plan BE-3 (bootstrap/port discovery file). Writer: the broker (BE-3). Readers:
every frontend client (FE-2), the SI-6 live-check runner.

---

## 1. Location

```
$AIBENDER_HOME/bootstrap/gateway.json
```

- `AIBENDER_HOME` resolves exactly like the rest of the machine-local layout
  (`resolveAibenderHome`): the `AIBENDER_HOME` environment variable if set,
  else `~/.aibender`. This mirrors the @aibender/shared identity-map
  resolution and the SI-2 profile conventions
  ([infra/profiles/README.md](../../infra/profiles/README.md)).
- The directory and file are **machine-local forever** — never committed,
  never synced [X2]. The path is stable across boots; only the CONTENT is
  per-boot.

## 2. Shape

```jsonc
{
  "port": 49152,                              // TCP port of the WS server on 127.0.0.1
  "token": "<base64url, per-boot random>",    // gateway auth token — SECRET, never log [X2]
  "pid": 12345,                               // broker process id
  "startedAt": "2026-07-04T00:00:00.000Z"     // ISO-8601 broker boot wall-clock
}
```

Field constraints (structural validator `isGatewayBootstrap` — total over
`unknown`, a torn/foreign file never throws):

| Field | Constraint |
|---|---|
| `port` | integer, 1–65535. The broker binds port 0 (OS-assigned) on `127.0.0.1` and advertises the result — the port is never configured. |
| `token` | non-empty string. Produced by `newBootToken()` (256-bit CSPRNG, base64url). Presented at WS connect time per [ws-protocol.md §1](ws-protocol.md). |
| `pid` | integer ≥ 1. Liveness probe input for the discovering client. |
| `startedAt` | ISO-8601 string, `Date.parse`-able. |

`(token, pid, startedAt)` together are the **boot identity**: when any of
them changes between reads, the client MUST treat the broker as restarted and
discard all reconnect-replay watermarks (ws-protocol.md §8).

## 3. Writer discipline (broker, [X2] hygiene)

The file carries a per-boot secret; the M1 implementation enforces, and this
contract freezes:

1. **Permissions**: file mode `0600`, directory mode `0700` — both enforced
   with **explicit `chmod` on every write** (`mkdir`/`writeFile` modes are
   umask-subject and only apply on creation).
2. **Atomic publish**: write to a temp file in the same directory
   (`.gateway.json.<pid>.tmp`), then `rename` onto the target — a reader can
   never observe a torn JSON body.
3. **Write-or-die**: the broker writes the file after binding; if the write
   fails, the boot FAILS loudly (a gateway nobody can discover is useless) —
   the server is shut down and the error propagates.
4. **Ownership-checked removal**: on shutdown the broker unlinks the file
   **only if it still carries this boot's token** (`removeBootstrapFile`).
   A stale broker exiting late can therefore never delete a newer boot's
   discovery file. Absent/foreign/unreadable files are left untouched.
5. **The token never appears in logs or error messages** — the gateway scrubs
   the token value from every outbound line (`createLineScrubber`).

## 4. Reader discipline (clients)

1. Read `$AIBENDER_HOME/bootstrap/gateway.json`; parse as JSON; validate
   structurally. **Absent, unreadable, or malformed all mean the same thing:
   "no broker advertised"** — never an error dialog, never a retry storm
   (freshness-state UX, blueprint §6.3 posture).
2. Optionally probe `pid` for liveness before connecting (a dead pid with a
   file present means a crashed broker — same "no broker advertised" state;
   the launchd `KeepAlive` policy is responsible for restarts, not the
   client).
3. Connect to `ws://127.0.0.1:<port>` presenting `token` per
   [ws-protocol.md §1](ws-protocol.md) (`?token=` query param — the browser
   WebSocket API cannot set headers — or `Authorization: Bearer`).
4. On reconnect, compare boot identity (§2) before sending any
   `replay-request`; a changed identity invalidates all watermarks.
5. Clients MUST NOT write, touch, or delete the file — the broker is the sole
   writer.

## 5. API surface (machine-checkable half)

`core/src/gateway/bootstrap.ts` (BE-3): `GatewayBootstrap`,
`BootstrapPathOptions`, `BOOTSTRAP_FILE_NAME`, `BOOTSTRAP_FILE_MODE` (0600),
`BOOTSTRAP_DIR_MODE` (0700), `resolveAibenderHome`, `bootstrapDir`,
`bootstrapPath`, `isGatewayBootstrap`, `writeBootstrapFile`,
`readBootstrapFile`, `removeBootstrapFile`.

The FE client implements the reader side against this prose (FE-2 owns its
own reader — the shape above is the contract, not the Node implementation).

## 6. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial FROZEN-M2 freeze, codifying the M1 gateway implementation verbatim (shape, 0600/0700 + chmod discipline, atomic publish, ownership-checked removal, write-or-die boot). Boot-identity → watermark-invalidation rule added alongside ws-protocol §8. FE-ORCH co-sign: **co-signed (M5 review, 2026-07-05)** — the FE reader side is implemented against this prose (`app/src/lib/bootstrap.ts`) and verified by `app/src/lib/bootstrap.spec.ts` (structural validation of absent/unreadable/malformed → "no broker advertised"; boot-identity change → watermark invalidation); clients never write the file. | — (M2 freeze) |
