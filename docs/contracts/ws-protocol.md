# WS protocol contract — envelope, channels, PTY frames, flow control

> ## 🔒 FROZEN-M3 — 2026-07-04
> **Owner: BE-ORCH · Co-sign: FE-ORCH.** The M3 freeze closes the ONE surface
> the M2 full freeze deliberately left open: the `events` channel **payload
> union** is now FROZEN (§13 — event summaries + the §6.3 read-model
> snapshots, with a frozen forward-tolerant unknown-kind rule). Every section
> below is **FROZEN** and changes **only** through an interface change
> request ([docs/contracts/icr/](icr/README.md)): an implementer files
> `icr-NNNN-<slug>.md`, BE-ORCH lands the change, FE-ORCH co-signs.
>
> The machine-checkable half of this contract is `packages/protocol`
> (`PROTOCOL_VERSION = '1.1.0'`, `PROTOCOL_FREEZE = 'FROZEN-M3'`). **This
> document is the prose of record when the two disagree — file an ICR, never
> a silent divergence.**

Blueprint anchors: §2 (topology), §4.1 (session substrates + permission
relay), §6.1 (collection matrix), §8 (context-graph feed), plan §3 (freeze
schedule), plan BE-3 (gateway). Flow-control mechanics were proven by SPIKE-D
(vi): 6 PTYs × 5 MB/s, one slow consumer, bounded memory, zero byte loss
([docs/spikes/spike-d-pty-supervision.md](../spikes/spike-d-pty-supervision.md)).

---

## 1. Transport & auth — FROZEN (M1-CORE; auth transport codified at M2)

- **One multiplexed WebSocket** at `ws://127.0.0.1:<port>`. The frontend never
  talks to Claude/OpenCode/LM Studio directly (blueprint §2).
- Two frame classes on the same socket:
  - **Text frames**: one JSON **envelope** per frame (§2).
  - **Binary frames**: PTY bytes in the binary frame format (§5). Never
    JSON-wrapped, never base64.
- Port + per-boot auth token are discovered via the bootstrap file
  ([bootstrap-file.md](bootstrap-file.md), FROZEN-M2).
- **Auth transport (M2 resolution of the M1 draft):** the client presents the
  bootstrap token **at connect time** — either as `?token=<token>` on the
  connection URL (the browser WebSocket API cannot set headers; the server is
  loopback-only and the token per-boot) or as an `Authorization: Bearer
  <token>` header. There is **no separate handshake message** — the M1
  placeholder was resolved as not needed; the M1 gateway implementation is
  the codified behavior. A missing/incorrect token answers a pushed
  `bad-auth` error (§7) and the connection is closed (code 1008).

## 2. Envelope — FROZEN (M1-CORE; seq scoping refined at M2)

```jsonc
{ "stream": "control",          // stream family, MUST equal streamForChannel(channel)
  "channel": "control",         // concrete channel instance (§3)
  "seq": 17,                    // per-channel monotonic counter, non-negative safe integer
  "payload": { ... } }          // channel-specific payload (discriminated on payload.kind)
```

- `seq` is assigned by the **sender** per channel and is monotonically
  increasing. **Scoping (M2):**
  - on the broker→client fan-out channels (`events`, `quota`, `approvals`,
    `transcript.<sid>`, `context-graph`) the broker's seq is scoped to
    **(broker boot, channel)** and continues across connections — this is the
    watermark axis for JSON reconnect-replay (§8);
  - on `control` and on client→broker traffic, seq is per-connection (control
    correlates by request id and is never replayed).
- PTY **byte** flow control does *not* use `seq` — it uses the binary frame's
  `streamOffset` axis (§6).
- Envelope validation failures answer `bad-envelope`; unknown/malformed
  channels answer `unknown-channel` (§7).
- Validators: `validateEnvelope` / `isEnvelope`.

## 3. Channel registry — FROZEN (M1-CORE; directions concretized at M2)

| Channel | Stream | Direction | Payloads |
|---|---|---|---|
| `control` | `control` | bidirectional | control requests/responses (§4), pushed `error` payloads (§7) |
| `events` | `events` | broker → client (+ client `replay-request` §8) | `event-summary` / `read-model-snapshot` + tolerated unknown kinds (§13, **frozen M3**) |
| `quota` | `quota` | broker → client (+ client `replay-request` §8) | `quota-snapshot` (§11) |
| `approvals` | `approvals` | bidirectional | `approval-request` / `approval-decision` / `approval-resolved` (§10) + client `replay-request` (§8) |
| `pty.<sid>` | `pty` | bidirectional | binary PTY frames (§5) + JSON flow-control messages (§6) |
| `transcript.<sid>` | `transcript` | broker → client (+ client `replay-request` §8) | `transcript-delta` / `transcript-tool` / `transcript-result` (§9) |
| `context-graph` | `context-graph` | broker → client (+ client `replay-request` §8) | `context-touch` (§12) |

`<sid>` is a **harness** session id (never a native id), charset
`[A-Za-z0-9_-]`, 1–64 chars (`SESSION_ID_SEGMENT_RE`, `MAX_SESSION_ID_BYTES`).

Any client payload not registered for a channel answers `bad-request` (the
"channel-policy" verdict in the golden corpus).

## 4. Control verbs — FROZEN (M1-CORE; `approve` retired-as-reserved at M2)

Requests are client → broker on `control`; each carries a client-generated
`id` (`[A-Za-z0-9_-]{1,128}`) and is answered by exactly one response with the
same `id`. Validator: `validateControlRequest` (broker inbound),
`validateControlResponse` (client inbound).

**Frozen verbs:** `launch` · `resume` · `kill` · `status`.
**Permanently reserved verb:** `approve` — **M2 decision**: the approvals
slice landed on the `approvals` channel (§10); decisions ride that channel,
not a control verb (session-scoped fan-out beats a point-to-point verb for a
multi-window inbox). The verb name stays registered-and-rejected
(`verb-reserved`) so no other meaning can squat on it; promoting it later is
an ICR.

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

## 5. Binary PTY frame format — FROZEN (M1-CORE, unchanged at M2)

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

## 6. Ack-watermark flow control — FROZEN (M1-CORE; attach-semantics prose pin post-M2)

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

**Attach semantics (behavior pin, amendment-recorded — prose only, no wire
change).** A connection receives binary OUTPUT frames for `pty.<sid>` only
after its FIRST `pty-replay-request` on that channel — the replay-request
doubles as the **attach verb**. `fromWatermark` names the start offset
(`0` = from session birth); acks then gate a bounded per-connection delivery
window. Clients that never attach receive nothing and pin nothing (their
watermarks never hold retained bytes). Consequences:

- clients MUST send `pty-replay-request` on the `pty.<sid>` channel on every
  (re)connect to start or resume the byte stream — there is no implicit
  attach at subscribe time;
- a `pty-ack` from a never-attached connection is a legal stale no-op at
  watermark `0` and answers `watermark-out-of-range` above it (the delivered
  offset is 0);
- a later `pty-replay-request` from an already-attached connection is the §6
  reconnect-replay path on the existing consumer, unchanged.

Implemented in `core/src/gateway/server.ts` (`handlePtyMessage`) +
`core/src/gateway/ptyStream.ts`; golden fixtures unaffected.

## 7. Error envelope — FROZEN (M1-CORE; one code added at M2)

Failed control requests answer `{ kind:"result", id, ok:false, error: ErrorDetail }`.
Failures with no request to answer (bad envelope, bad auth, unknown channel,
oversized frame, non-pending approval decision) are pushed on `control` as:

```jsonc
{ "kind": "error", "code": "bad-auth", "message": "…", "retryable": false,
  "correlatesTo": "req_01"?, "channel": "pty.s01"? }
```

`ErrorDetail = { code, message, retryable }`. Messages are identifier-free
[X2] (redaction filters apply upstream). Closed code registry (`ERROR_CODES`):

`bad-envelope` · `bad-auth` · `unknown-channel` · `unknown-verb` ·
`verb-reserved` · `bad-request` · `session-not-found` ·
`session-not-resumable` · `double-resume-blocked` · `approval-not-pending` ·
`oversized-frame` · `watermark-out-of-range` · `internal`

`approval-not-pending` (M2, amendment-recorded): a decision referenced an
approval that is not pending — unknown id, already resolved, or expired. This
race is **normal** (two windows; expiry vs. click) and is deliberately
distinct from `bad-request`. `watermark-out-of-range` now covers both the PTY
byte axis (§6) and the JSON seq axis (§8).

Adding a code after freeze is an ICR.

## 8. JSON reconnect-replay — FROZEN (M2)

Promoted from the M1 draft. Mechanism (mirrors the PTY path, with `seq` as
the axis):

- The broker journals a **bounded** window of outbound envelopes per
  replayable channel, scoped to the broker boot. Replayable channels =
  the broker→client fan-out set: `events`, `quota`, `approvals`,
  `transcript.<sid>`, `context-graph` (`isReplayableChannel`). NOT `control`
  (correlates by id, dies with the connection) and NOT `pty.<sid>` (bytes
  replay on the `streamOffset` axis, §6).
- On (re)connect a client MAY send one `replay-request` per channel — **on
  that channel**:

```jsonc
{ "kind": "replay-request", "channel": "transcript.ses_01", "fromSeq": 42 }
```

- The embedded `channel` MUST equal the envelope's channel (cross-checked,
  like pty sessionIds). `fromSeq` = the first seq the client has NOT
  processed; the broker re-sends every retained envelope with
  `seq >= fromSeq`, in order, with their **original** seq values, then live
  flow continues. `fromSeq === lastSeq + 1` is a legal no-op.
- `fromSeq` beyond `lastSeq + 1`, or below the journal's retention floor,
  answers `watermark-out-of-range`. Below-floor history is unrecoverable from
  the wire **by design** (bounded memory) — the client rebuilds from read
  models / the store.
- A broker **restart** invalidates every watermark. The client detects it via
  the bootstrap file's boot identity (token/pid/startedAt —
  [bootstrap-file.md](bootstrap-file.md)) and starts fresh.
- Validator: `validateJsonReplayRequest(value, expectedChannel)`.

**M3 resolution of the M2 deferral:** the `events` channel **payload union**
froze at M3 with BE-5's normalized events store (§13). Client payloads on
`events` (other than `replay-request`) still answer `bad-request`; broker
pushes now validate against the frozen union, with unknown kinds
legal-and-ignored by the frozen forward-tolerant reader rule (§13 — the M2
"opaque envelope" policy made permanent).

## 9. `transcript.<sid>` payloads — FROZEN (M2)

The SDK message-stream projection (blueprint §4.1). Broker → client. The
projection is deliberately narrow — full message bodies and tool
inputs/outputs stay off this channel (transcripts of record live in the
per-account JSONL files; tool/file semantics flow through
[hooks-contract.md](hooks-contract.md)). Validator:
`validateTranscriptPayload(value, expectedSessionId)` — sessionId is
cross-checked against the channel name.

| Kind | Fields | Semantics |
|---|---|---|
| `transcript-delta` | `sessionId`, `messageUuid`, `text` | streamed assistant text; grouped client-side on `messageUuid`; `text` non-empty (empty deltas are never sent) |
| `transcript-tool` | `sessionId`, `toolUseId`, `toolName`, `phase`, `ok?` | tool lifecycle; `phase` ∈ `start · result`; `ok` REQUIRED on `result`, FORBIDDEN on `start` |
| `transcript-result` | `sessionId`, `ok`, `detail`, `usage`, `costUsd?`, `durationMs?` | terminal result; `detail` = SDK result subtype; `usage` = the four ground-truth token classes `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` (blueprint §6.2 — cache-TTL split lives in the events store, not on this wire); `costUsd` is an ESTIMATE |

## 10. `approvals` payloads — FROZEN (M2)

One approval inbox for every escalation source (blueprint §4.1 two-layer
permission relay; §9.3 BE↔FE #4). The union covers all three sources now, so
M3–M5 slot in without wire changes. Validators:
`validateApprovalsClientMessage` (broker inbound) /
`validateApprovalsServerMessage` (client inbound).

**Flow:** broker pushes `approval-request` → a client answers
`approval-decision` → broker fans out `approval-resolved` to every connected
client (including the decider). Requests and resolutions replay on reconnect
(§8); a decision for a non-pending approval answers the pushed error
`approval-not-pending` (§7).

### 10.1 `approval-request` (broker → client)

Common fields: `approvalId` (`[A-Za-z0-9_-]{1,128}`), `source`, `summary`
(identifier-free [X2]), `accountLabel` (placeholder labels only [X2]),
`expiresAt?` (epoch ms; on expiry the broker resolves `expired`).

Per-source field matrix (validated):

| `source` | `sessionId` | `toolName` | `toolUseId` | `runId`/`stepId` |
|---|---|---|---|---|
| `can-use-tool` (SDK in-loop relay) | REQUIRED | REQUIRED | optional | forbidden |
| `hook-floor` (account-wide http hooks — the policy floor for ALL sessions incl. external) | REQUIRED | REQUIRED | optional | forbidden |
| `workflow-gate` (pipeline `approval` gates, M5) | optional | forbidden | forbidden | REQUIRED |

### 10.2 `approval-decision` (client → broker)

`{ kind, approvalId, verdict, updatedInput?, note? }` — `verdict` ∈
`allow · deny`; `updatedInput` (opaque object) relays the canUseTool
replacement input and is **only legal with `allow`**; `note` (identifier-free
[X2]) relays the deny message.

### 10.3 `approval-resolved` (broker → client)

`{ kind, approvalId, outcome }` — `outcome` ∈ `allowed · denied · expired ·
superseded` (`superseded` = the underlying wait vanished: session died,
workflow run aborted).

## 11. `quota` payload — FROZEN (M2)

Broker → client. Mirrors the `quota_snapshots` DDL row (blueprint §6.1/§6.2).
Validator: `validateQuotaSnapshot`.

```jsonc
{ "kind": "quota-snapshot",
  "account": "MAX_A",          // placeholder labels only [X2]
  "window": "5h",              // 5h | 7d | 7d_sonnet
  "usedPct": 41.5,             // 0..100 inclusive (collector clamps upstream noise)
  "resetsAt": 90200000,        // epoch ms — authoritative from the feed; past values legal
  "capturedAt": 90100000,      // epoch ms, broker-side capture instant
  "source": "statusline" }     // statusline (primary) | oauth-poll (idle fallback)
```

Missing-source freshness is a read-model state (NO SIGNAL) — the broker never
fabricates a snapshot (plan §9.2 BE-6 negative row).

## 12. `context-graph` payload — FROZEN (M2)

Broker → client — the live graph feed (feature 6). Validator:
`validateContextGraphTouch`.

```jsonc
{ "kind": "context-touch",
  "sessionId": "ses_01",                       // harness session id
  "path": "/abs/path/to/artifact",             // absolute file path
  "relation": "read",                          // read | write | instructions | watched
  "ts": 90100000 }                             // epoch ms
```

**[X2] design pin — identity-free by construction:** payloads carry file
paths and session ids ONLY. There is no account field, and the validator
**rejects** payloads carrying `account`/`accountLabel` keys outright (golden
fixture `context-touch-account-key-rejected`). Relations map from the hook
vocabulary ([hooks-contract.md](hooks-contract.md)): `PostToolUse` on
read/write-shaped tools → `read`/`write`; `InstructionsLoaded` →
`instructions`; `FileChanged` → `watched`.

**Session-id relay (M3 stewarding pin, prose only — no wire change):**
`sessionId` is a harness session id *where the broker knows one*. Hook
bodies and native watcher surfaces carry NATIVE session ids, and the ledger
mapping lands with BE-7 (M4) — until then the feed maps to a harness id
where the ledger knows one, **else relays the native id** (charset-validated,
never rewritten; ids that fail the wire charset are dropped). This mirrors
the frozen approvals-relay precedent verbatim (hooks-contract.md §7,
`hookFloorRelayInput`). The producer seam is injectable
(`resolveSessionId`, core/src/collector/graphfeed/hookTouches.ts): at M4
the composition root MUST inject the ledger resolver so harness ids take
over — consumers see no shape change either way.

## 13. `events` payloads — FROZEN (M3)

Broker → client — the collector fan-out (blueprint §6.1/§6.2, plan
§4/BE-5/BE-6). The union the M2 freeze deferred; frozen at M3 together with
the events store DDL ([sqlite-ddl.md](sqlite-ddl.md) migration 0002).
Validator: `validateEventsPayload`. Types: `events.ts` + `readModels.ts` in
`packages/protocol`.

### 13.1 `event-summary`

One normalized events-store row, fanned out for live dashboards. Mirrors the
`events` fact table MINUS everything value-heavy or machine-locating [X2]:
NO `raw_ref`, NO `file_refs`, NO native ids, NO tool/prompt bodies.

```jsonc
{ "kind": "event-summary",
  "eventId": 42,                  // events-store row id (dashboard ordering/dedupe axis)
  "ts": 90100500,                 // epoch ms
  "account": "AWS_DEV",           // placeholder labels only [X2]
  "backend": "opencode",          // must satisfy the frozen label↔backend pairing
  "source": "opencode-sse",       // EVENT_SOURCES (the §6.1 matrix, closed registry)
  "eventType": "message.part.updated",  // OPEN vocabulary (CLI minors add events)
  "sessionId": "ses_…",           // optional — harness id only
  "model": "…", "usage": { … },   // optional; usage = the four token classes (§9 shape)
  "costEstimatedUsd": 0.012,      // optional; always an estimate
  "costActualUsd": 0.011,         // optional; Cost Explorer backfill when landed
  "latencyMs": 900, "ttftMs": 120,
  "toolName": "Read", "skillName": "…",
  "ok": true, "errorKind": "retry" }   // errorKind ∈ error·retry·throttle·timeout
```

### 13.2 `read-model-snapshot`

The ten §6.3 dashboard leads (closed registry `READ_MODEL_IDS`, in blueprint
order): `quota-gauges` · `burn-rate` · `bedrock-cost` · `api-equivalent-usd`
· `cache-hit-rate` · `latency` · `health` · `skill-leaderboard` ·
`session-outcomes` · `local-offload`. Common envelope:

```jsonc
{ "kind": "read-model-snapshot",
  "readModel": "quota-gauges",
  "capturedAt": 90100000,          // epoch ms
  "sources": [                     // REQUIRED, non-empty: per-source freshness
    { "source": "claude-quota", "state": "fresh", "lastIngestAt": 90099000 } ],
  "data": { … } }                  // per-readModel shape (readModels.ts)
```

**Freshness is a first-class field, never an error** (blueprint §6.3):
`state` ∈ `fresh · stale · no-signal · lmstudio-down · cluster-absent ·
sso-expired · account-logged-out · estimate-only`
(`SOURCE_FRESHNESS_STATES`). A degraded source renders NO SIGNAL from its
freshness entry; producers never fabricate zeros; absent optional data
fields (Bedrock actuals while gated, correction rates before the local-model
job) mean "not computable yet" with the freshness entry saying why. Honesty
pins are validated, not advisory: `api-equivalent-usd` carries the frozen
literal `basis: "api-equivalent"` (equivalence, never spend); quota/burn
percentages are 0–100; `p95 >= p50`; `localTokens <= totalTokens`.

### 13.3 Forward-tolerant reader rule — FROZEN

A broker push on `events` whose `kind` is a non-empty string OUTSIDE the
frozen set is **legal and MUST be ignored by clients** (decoded as an opaque
payload). This makes later milestones' dashboard kinds (M4 workstream
lenses, M5 pipeline run monitors) non-breaking for M3 clients — the M2
"opaque envelope" policy made permanent. Tolerance applies to KINDS only:
malformed **registered** kinds, kindless payloads, and unknown `readModel` /
`source` / freshness values answer `bad-request`. Golden fixtures:
`events-unknown-kind-tolerated`, `events-broker-payload-draft-opaque`
(the M2-era frame, byte-identical, still valid).

## 14. Golden corpus — the BE↔FE contract device

`GOLDEN_WS_FIXTURES` in `packages/testkit` (ICR-0003, extended at the M2
freeze and again at this M3 freeze with the `events-payload` stage;
`GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M3'` must equal the protocol package's
`PROTOCOL_FREEZE`). Every frozen payload family has valid + every invalid
class pinned as exact wire bytes — including one valid snapshot per §6.3
read model; both departments' CI replays the same frames (plan §9.3 BE↔FE
#1). A fixture change requires both orchestrators' sign-off. The hooks
acceptance surface has its own sibling corpus (`GOLDEN_HOOK_FIXTURES`,
[hooks-contract.md §6](hooks-contract.md)).

## 15. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1-CORE freeze | — (the freeze itself) |
| 2026-07-04 | §4.2: optional `prompt` on resume params (sdk substrate requires it at M1); §4.1: launch `state` = ledger state at response time (M1 composition note). Additive, backward-compatible — old resume frames stay valid. | [ICR-0004](icr/icr-0004-resume-prompt.md) |
| 2026-07-04 | **M2 FULL FREEZE.** Promoted: transcript (§9), approvals (§10), quota (§11), context-graph (§12) payload unions; JSON reconnect-replay + per-(boot, channel) seq scoping (§2/§8); auth transport codified as connect-time token, handshake-message draft resolved as not needed (§1). Amended frozen surfaces (recorded here, landed by the freeze agent): error code `approval-not-pending` added (§7); `approve` verb retired-as-reserved — decisions ride the approvals channel (§4); §3 directions concretized (broker→client fan-out channels accept the client `replay-request`). Deferred: `events` payload union → M3 (§8). Protocol `1.0.0-m1-core` → `1.0.0`. FE-ORCH co-sign: **pending** (validator-derived, additive except the recorded amendments). | — (M2 freeze) |
| 2026-07-04 | §6 **attach-semantics behavior pin** (prose only, NO wire change, requested in the BE-3 M2 return): OUTPUT frames for `pty.<sid>` flow to a connection only after its first `pty-replay-request` on that channel — the replay-request doubles as the attach verb (`fromWatermark` 0 = from session birth); never-attached connections receive nothing and pin nothing; clients must replay-request on every (re)connect. Matches the landed BE-3 implementation and the FE-2 client's documented duty; golden fixtures unaffected. FE-ORCH co-sign: **pending** (bundled with the M2 freeze co-sign). | — (BE-ORCH steward, prose pin) |
| 2026-07-04 | **M3 FREEZE.** Closed the one open surface: the `events` payload union (§13) — `event-summary` (normalized events-store row fan-out, value-light [X2]) + `read-model-snapshot` (the ten §6.3 dashboard leads with a REQUIRED per-source freshness field; degraded sources are states, never errors) + the frozen forward-tolerant unknown-kind rule (§13.3, the M2 opaque policy made permanent). New closed registries: `EVENT_SOURCES`, `SOURCE_FRESHNESS_STATES`, `EVENT_ERROR_KINDS`, `READ_MODEL_IDS` (shared with schema migration 0002 CHECKs). Verified sufficient, NO amendment: quota snapshot (§11) carries the statusline tee data exactly (five_hour/seven_day → 5h/7d, usedPct, resetsAt); context-graph touch (§12) stays paths+session-ids only [X2]. Corpus: `events-payload` stage added; fixture `events-broker-payload-draft-opaque` kept byte-identical and valid, its pinned stage moved channel-policy→events-payload (the deferral resolving as recorded at M2); 19 new events fixtures (valid per read model + every invalid class). Protocol `1.0.0` → `1.1.0`, `FROZEN-M2` → `FROZEN-M3`. No new error codes; no change to any M1/M2 wire shape. FE-ORCH co-sign: **pending** (includes the one-line freeze-literal advance in `app/src/features/launch/wire.spec.ts`). | — (M3 freeze) |
| 2026-07-04 | §12 **session-id relay pin** (prose only, NO wire change; requested in the BE-6 M3 return): `sessionId` documented as harness-id-where-known with native-id relay until the BE-7/M4 ledger mapping — the exact hooks-contract §7 approvals-relay sentence, now stated for context-graph too; the composition root MUST inject the ledger resolver at M4 (the `resolveSessionId` seam, core/src/collector/graphfeed/hookTouches.ts). Validator, charset and golden fixtures unchanged. FE-ORCH co-sign: n/a (no wire change). | — (BE-ORCH steward, prose pin) |
