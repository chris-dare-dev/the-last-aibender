# WS protocol contract — envelope, channels, PTY frames, flow control

> ## 🔒 FROZEN-M1-CORE — 2026-07-04
> **Owner: BE-ORCH · Co-sign: FE-ORCH.** After this banner, the sections marked
> **FROZEN** change **only** through an interface change request
> ([docs/contracts/icr/](icr/README.md)): an implementer files `icr-NNNN-<slug>.md`,
> BE-ORCH lands the change, FE-ORCH co-signs. Sections marked **DRAFT (M2)**
> freeze at M2 and may still move until then.
>
> The machine-checkable half of this contract is `packages/protocol`
> (`PROTOCOL_VERSION = '1.0.0-m1-core'`). **This document is the prose of
> record when the two disagree — file an ICR, never a silent divergence.**

Blueprint anchors: §2 (topology), §4.1 (session substrates), plan §3 (freeze
schedule), plan BE-3 (gateway). Flow-control mechanics were proven by SPIKE-D
(vi): 6 PTYs × 5 MB/s, one slow consumer, bounded memory, zero byte loss
([docs/spikes/spike-d-pty-supervision.md](../spikes/spike-d-pty-supervision.md)).

---

## 1. Transport — FROZEN (M1-CORE)

- **One multiplexed WebSocket** at `ws://127.0.0.1:<port>`. The frontend never
  talks to Claude/OpenCode/LM Studio directly (blueprint §2).
- Two frame classes on the same socket:
  - **Text frames**: one JSON **envelope** per frame (§2).
  - **Binary frames**: PTY bytes in the binary frame format (§5). Never
    JSON-wrapped, never base64.
- Port + per-boot auth token are discovered via the bootstrap file
  (`docs/contracts/bootstrap-file.md`, freezes M2). The auth **handshake
  message** is DRAFT (§8); the *requirement* that an unauthenticated
  connection is rejected with `bad-auth` and closed is frozen now.

## 2. Envelope — FROZEN (M1-CORE)

```jsonc
{ "stream": "control",          // stream family, MUST equal streamForChannel(channel)
  "channel": "control",         // concrete channel instance (§3)
  "seq": 17,                    // per-channel monotonic counter, non-negative safe integer
  "payload": { ... } }          // channel-specific payload (discriminated on payload.kind)
```

- `seq` is assigned by the **sender** per channel and is monotonically
  increasing. It feeds reconnect bookkeeping on JSON channels. PTY **byte**
  flow control does *not* use `seq` — it uses the binary frame's
  `streamOffset` axis (§6).
- Envelope validation failures answer `bad-envelope`; unknown/malformed
  channels answer `unknown-channel` (§7).
- Validators: `validateEnvelope` / `isEnvelope`.

## 3. Channel registry — FROZEN (M1-CORE)

| Channel | Stream | Direction | Payloads |
|---|---|---|---|
| `control` | `control` | bidirectional | control requests/responses (§4), pushed `error` payloads (§7) |
| `events` | `events` | broker → client | DRAFT (M2) |
| `quota` | `quota` | broker → client | DRAFT (M2) |
| `approvals` | `approvals` | bidirectional | DRAFT (M2; pairs with reserved `approve` verb) |
| `pty.<sid>` | `pty` | bidirectional | binary PTY frames (§5) + JSON flow-control messages (§6) |
| `transcript.<sid>` | `transcript` | broker → client | DRAFT (M2) |
| `context-graph` | `context-graph` | broker → client | DRAFT (M2) |

`<sid>` is a **harness** session id (never a native id), charset
`[A-Za-z0-9_-]`, 1–64 chars (`SESSION_ID_SEGMENT_RE`, `MAX_SESSION_ID_BYTES`).

## 4. Control verbs — FROZEN (M1-CORE)

Requests are client → broker on `control`; each carries a client-generated
`id` (`[A-Za-z0-9_-]{1,128}`) and is answered by exactly one response with the
same `id`. Validator: `validateControlRequest` (broker inbound),
`validateControlResponse` (client inbound).

**Frozen verbs:** `launch` · `resume` · `kill` · `status`.
**Reserved verb:** `approve` — the name is registered, the shape is
deliberately unfrozen until M2; sending it now answers `verb-reserved`.

### 4.1 launch

```jsonc
{ "kind": "launch", "id": "req_01",
  "params": {
    "accountLabel": "MAX_A",       // MAX_A | MAX_B | ENT | AWS_DEV | LOCAL  [X2 placeholders]
    "backend": "claude_code",      // must match the label: MAX_*/ENT→claude_code, AWS_DEV→opencode, LOCAL→lmstudio
    "substrate": "sdk",            // sdk | pty — pty is claude_code-only (blueprint §4.1)
    "cwd": "/abs/path",            // absolute, byte-stable (blueprint §3 rule 2)
    "purpose": "one-off prompt",   // lands in the resume ledger row-before-spawn
    "workstreamHint": "ws_…",      // optional, X4 ledger hint
    "prompt": "…" } }              // optional, headless one-off (feature 2)
```

Response result: `{ "verb": "launch", "sessionId": "ses_…", "state": "spawning" }`
(the row-before-spawn row exists **before** the response is sent; the process
spawn proceeds asynchronously — watch `status`/`events`).

> **M1 composition note (ICR-0004):** `state` reports the **ledger state at
> response time**. The M2 broker loop answers `spawning` as shown; the M1
> composition (`composeBroker`) awaits the SDK spawn before answering, so
> `running` (or `exited`, for a query that already settled) is an equally
> legal M1 answer. Clients must accept any registered `SessionState` here —
> the validators always have.

### 4.2 resume

```jsonc
{ "kind": "resume", "id": "req_02",
  "params": { "sessionId": "ses_…", "fork": false, "prompt": "…" } }   // prompt optional (ICR-0004)
```

- `fork: false` (default): resume in place. **Refused with
  `double-resume-blocked` when the session is in a running-family state** —
  un-forked double-resume is the transcript-corruption mode (blueprint §5).
- `fork: true`: resume as forkSession → continuation **child** (X4 edge).
- `prompt` (**ICR-0004**, optional, non-empty string when present): the next
  user prompt the resumed session processes. The wire shape is
  substrate-agnostic, but the **`sdk` substrate requires it at M1** — an SDK
  resume without a new user prompt is not meaningful at SDK 0.3.201, so the
  broker answers `bad-request` when it is absent for an sdk session. Golden
  fixtures: `control-resume-with-prompt`, `control-resume-blank-prompt`.
- Result: `{ "verb": "resume", "sessionId": "ses_child-or-same", "state": "resumed", "forkedFrom": "ses_parent"? }`.

### 4.3 kill

```jsonc
{ "kind": "kill", "id": "req_03",
  "params": { "sessionId": "ses_…", "mode": "graceful" } }   // graceful (default) | force
```

`graceful` checkpoints then terminates (feeds the recycle/lineage path);
`force` is SIGKILL-class, process-**group** targeted (SPIKE-D finding 2).
Result: `{ "verb": "kill", "sessionId": "ses_…", "state": "exited" }`.

### 4.4 status

```jsonc
{ "kind": "status", "id": "req_04", "params": { "sessionId": "ses_…" } }  // params optional → all sessions
```

Result: `{ "verb": "status", "sessions": [SessionStatus…] }` where
`SessionStatus = { sessionId, accountLabel, backend, substrate, state, cwd,
purpose, workstreamHint?, nativeSessionId?, pid? }`. `state` ∈
`spawning · running · resumed · orphan_detected · orphan_killed · exited`
(the resume-ledger state machine — DDL contract §4 of
[sqlite-ddl.md](sqlite-ddl.md)).

## 5. Binary PTY frame format — FROZEN (M1-CORE)

Constants and codec: `PTY_FRAME_MAGIC`, `PTY_FRAME_VERSION`,
`PTY_FRAME_HEADER_BYTES`, `PTY_FRAME_MAX_PAYLOAD_BYTES`, `encodePtyFrame`,
`decodePtyFrame` (Uint8Array/DataView only — runs in WKWebView and Node).

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | u8 | magic | `0xAB` |
| 1 | u8 | version | `0x01` |
| 2 | u8 | frameType | `0x01` OUTPUT (broker→client) · `0x02` INPUT (client→broker) |
| 3 | u8 | sidLength | 1–64 |
| 4 | u64 BE | streamOffset | absolute byte offset of `payload[0]` in the session's directional byte stream |
| 12 | u32 BE | payloadLength | 0 – 1 MiB (`PTY_FRAME_MAX_PAYLOAD_BYTES`) |
| 16 | bytes | sessionId | ASCII, charset `[A-Za-z0-9_-]` |
| 16+sidLength | bytes | payload | raw PTY bytes |

Rules:

- `streamOffset` is the **watermark axis**: OUTPUT offsets count broker→client
  bytes per session; acks and replays (§6) reference this axis. Decoded
  offsets beyond `Number.MAX_SAFE_INTEGER` are rejected.
- Frames larger than header-declared length, above the payload cap, with bad
  magic/version/type, or with a malformed sid are rejected with
  `oversized-frame` — decoding never throws on wire data.
- Larger output is **split** by the sender; frames are never merged across the
  cap.

## 6. Ack-watermark flow control — FROZEN (M1-CORE)

JSON messages on the session's `pty.<sid>` channel. Validator:
`validatePtyClientMessage(value, expectedSessionId)` — the gateway always
cross-checks the payload's `sessionId` against the channel name.

| Kind | Direction | Fields | Semantics |
|---|---|---|---|
| `pty-ack` | client → broker | `sessionId`, `watermark` | every OUTPUT byte with offset < `watermark` is consumed; the broker may release it from the bounded buffer. Watermarks are monotonic — stale acks are ignored; an ack beyond the delivered offset answers `watermark-out-of-range`. |
| `pty-replay-request` | client → broker | `sessionId`, `fromWatermark` | reconnect path: replay every retained OUTPUT byte from `fromWatermark`. A watermark below the last ack is unrecoverable **by design** (those bytes were released) → `watermark-out-of-range`; the client must re-attach via the serialize-addon snapshot instead. |
| `pty-resize` | client → broker | `sessionId`, `cols`, `rows` | terminal geometry; 1–4096 each. |

**Pause/resume never crosses the wire.** The broker owns a bounded per-session
ack buffer (SPIKE-D: cap 4 MiB, highWater 2 MiB, lowWater 512 KiB — production
values are BE-3 configuration, the *mechanism* is the contract): occupancy ≥
highWater → `pty.pause()` (kernel PTY buffer fills → child's TTY write blocks
→ backpressure reaches the producer); ack drains to lowWater → `resume()`.
Bytes are **never dropped**; a cap breach is a broker bug (assertion), not a
wire condition.

## 7. Error envelope — FROZEN (M1-CORE)

Failed control requests answer `{ kind:"result", id, ok:false, error: ErrorDetail }`.
Failures with no request to answer (bad envelope, bad auth, unknown channel,
oversized frame) are pushed on `control` as:

```jsonc
{ "kind": "error", "code": "bad-auth", "message": "…", "retryable": false,
  "correlatesTo": "req_01"?, "channel": "pty.s01"? }
```

`ErrorDetail = { code, message, retryable }`. Messages are identifier-free
[X2] (redaction filters apply upstream). Closed code registry (`ERROR_CODES`):

`bad-envelope` · `bad-auth` · `unknown-channel` · `unknown-verb` ·
`verb-reserved` · `bad-request` · `session-not-found` ·
`session-not-resumable` · `double-resume-blocked` · `oversized-frame` ·
`watermark-out-of-range` · `internal`

Adding a code after freeze is an ICR.

## 8. DRAFT (M2) — do not build against as frozen

- **Auth handshake message** (per-boot token from the bootstrap file). Frozen
  requirement already in force: unauthenticated traffic answers `bad-auth` and
  the connection closes.
- **Payload unions** for `events`, `quota`, `approvals`, `transcript.<sid>`,
  `context-graph` (placeholders: `draft.ts`).
- **`approve` verb** request/response shape (approvals slice, plan BE-3/FE-2).
- Reconnect **replay watermark** semantics for JSON channels (per-channel
  `seq` replay); PTY replay is already frozen (§6).

## 9. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1-CORE freeze | — (the freeze itself) |
| 2026-07-04 | §4.2: optional `prompt` on resume params (sdk substrate requires it at M1); §4.1: launch `state` = ledger state at response time (M1 composition note). Additive, backward-compatible — old resume frames stay valid. | [ICR-0004](icr/icr-0004-resume-prompt.md) |
