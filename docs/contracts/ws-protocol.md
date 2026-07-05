# WS protocol contract — envelope, channels, PTY frames, flow control

> ## 🔒 FROZEN-M5 — 2026-07-04
> **Owner: BE-ORCH · Co-sign: FE-ORCH.** The M5 freeze adds the features-4/5
> surfaces: the **`pipelines` channel** (§18 — the catalog palette snapshot,
> the pipeline run monitor, and the client verbs
> validate/save/launch/pause/resume/cancel). Approval GATES ride the EXISTING
> approvals channel via the frozen `workflow-gate` source (§10.1) — no new gate
> wire (the M2 one-inbox precedent). The versioned JSON DAG document format the
> verbs carry is its own contract, [dag-schema.md](dag-schema.md). Every M1–M4
> shape is carried forward unchanged (M4 froze the `workstream` channel §16 +
> the lineage seams §15). Every section below is **FROZEN** and changes **only**
> through an interface change request ([docs/contracts/icr/](icr/README.md)): an
> implementer files `icr-NNNN-<slug>.md`, BE-ORCH lands the change, FE-ORCH
> co-signs.
>
> The machine-checkable half of this contract is `packages/protocol`
> (`PROTOCOL_VERSION = '1.3.0'`, `PROTOCOL_FREEZE = 'FROZEN-M5'`). **This
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
| `workstream` | `workstream` | bidirectional | lineage fan-out + tolerated unknown kinds / client `workstream-merge-request` + `replay-request` (§16, **frozen M4**) |
| `pipelines` | `pipelines` | bidirectional | catalog + run-monitor fan-out + tolerated unknown kinds / client pipeline verbs + `replay-request` (§18, **frozen M5**) |

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
`workstream-not-found` · `pipeline-not-found` · `pipeline-run-not-found` ·
`pipeline-invalid` · `step-not-found` · `oversized-frame` ·
`watermark-out-of-range` · `internal`

`approval-not-pending` (M2, amendment-recorded): a decision referenced an
approval that is not pending — unknown id, already resolved, or expired. This
race is **normal** (two windows; expiry vs. click) and is deliberately
distinct from `bad-request`. `watermark-out-of-range` now covers both the PTY
byte axis (§6) and the JSON seq axis (§8).

`workstream-not-found` (M4, amendment-recorded): a `workstream-merge-request`
named a `workstreamId` with no workstream row (§16.4). Runtime state, never
conflated with malformed traffic — the lineage-entity parallel of
`session-not-found`.

`pipeline-not-found` · `pipeline-run-not-found` · `pipeline-invalid` ·
`step-not-found` (M5, amendment-recorded): the pipeline verbs' runtime failures
(§18.4). `pipeline-not-found` = an unknown saved `pipelineId`;
`pipeline-run-not-found` = an unknown `runId` on pause/resume/cancel;
`pipeline-invalid` = a launch/save carried a DAG document that failed static
validation (the detail rides the `pipeline-validation-result` payload, the error
itself is GENERIC [X2]); `step-not-found` = a referenced step id absent from the
run's document. All runtime state, never conflated with malformed traffic.

Adding a code after freeze is an ICR.

## 8. JSON reconnect-replay — FROZEN (M2)

Promoted from the M1 draft. Mechanism (mirrors the PTY path, with `seq` as
the axis):

- The broker journals a **bounded** window of outbound envelopes per
  replayable channel, scoped to the broker boot. Replayable channels =
  the broker→client fan-out set: `events`, `quota`, `approvals`,
  `transcript.<sid>`, `context-graph`, `workstream` (M4), and — M5,
  amendment-recorded — `pipelines` (`isReplayableChannel`). NOT `control`
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
over — consumers see no shape change either way. **M4 resolution:** the
resolver port type froze as `SessionIdResolver` (§15.2).

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
freeze, the M3 freeze with the `events-payload` stage, the M4 freeze
with the `workstream-payload` + `workstream-client-message` stages, and the
M5 freeze with the `pipelines-payload` + `pipelines-client-message` stages;
`GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M5'` must equal the protocol package's
`PROTOCOL_FREEZE`). Every frozen payload family has valid + every invalid
class pinned as exact wire bytes — including one valid snapshot per §6.3
read model, one valid frame per §16 workstream kind, and one valid frame per
§18 pipelines kind + each verb; both departments' CI replays the same frames
(plan §9.3 BE↔FE #1). A fixture change requires both orchestrators' sign-off.
The hooks acceptance surface has its own sibling corpus (`GOLDEN_HOOK_FIXTURES`,
[hooks-contract.md §6](hooks-contract.md)).

## 15. Lineage seams — FROZEN (M4)

Not wire surfaces: two port types the M4 freeze pins in `packages/protocol`
(`workstreams.ts`) because THREE lanes must agree on them (the hooks.ts /
acceptance-types precedent). Appended after §14 so no M1–M3 section number
moved.

### 15.1 `LineageRecorder` — the kernel-facing edge-recording interface

Blueprint §5 recording discipline: **edges are recorded deterministically at
action time** because every launch/resume/fork/recycle/merge flows through
the harness. The frozen port:

```ts
interface LineageRecorder { record(action: LineageAction): void }
```

`LineageAction` (discriminated on `kind`, all ids HARNESS ids):

| Kind | Fields | Lineage meaning |
|---|---|---|
| `launch` | `sessionId`, `accountLabel`, `backend`, `cwd`, `workstreamHint?`, `atEpochMs` | new `session_node` (the resume-ledger id IS the node id) |
| `resume` | `fromSessionId`, `toSessionId`, `atEpochMs` | `continue` edge — a continuation is a CHILD; in-place resume carries from === to |
| `fork` | `fromSessionId`, `toSessionId`, `atEpochMs` | `fork` edge to the new child |
| `recycle` | `fromSessionId`, `toSessionId`, `checkpointRef?`, `atEpochMs` | `continue` edge via checkpoint (the M2 `ContinuationEdgeEmitter` stub, generalized — same-node recycles carry from === to) |
| `merge` | `parentSessionIds` (2..16 distinct), `toSessionId`, `briefId?`, `atEpochMs` | N `merge_parent` edges into ONE new node |

Rules: `record` never throws and is never awaited by the kernel path
(fire-and-forget for the CALLER; a throwing recorder is a recorder bug);
kernel-recorded rows are `confidence: 'recorded'`; the reconciler covers
EXTERNAL sessions only and never rides this port. BE-1/BE-2 call it on every
action; BE-7 implements it over the schema lineage store (sqlite-ddl.md §8);
`noopLineageRecorder` is the frozen M1–M3 default. The composition root
adapts BE-2's `ContinuationEdgeEmitter` stub
(core/src/kernel/pty/ptyHost.ts) onto this port.

### 15.2 `SessionIdResolver` — the ledger native→harness mapping

The §12 M4 pin, frozen as a type:

```ts
type SessionIdResolver = (nativeSessionId: string) => string | undefined;
```

Return the harness id where the ledger knows the native id; return the
INPUT VERBATIM to relay the native id (external sessions stay visible under
their native id until the reconciler registers them; charset-validated
downstream, never rewritten); return `undefined` to DROP (the feed never
guesses). BE-7 implements it (`session_node.byNativeSessionId` +
`resume_ledger.native_session_id` — one database, §8.1 of sqlite-ddl.md);
composeBroker MUST inject it into the graphfeed (`resolveSessionId`) and the
hooks approvals relay (`sessionIdOfNative`) at M4.

## 16. `workstream` payloads — FROZEN (M4)

The X4 lineage view feed (blueprint §5, §8; plan §4/BE-7, §5/FE-6/FE-4).
Bidirectional like `approvals`; replayable (§8). Validators:
`validateWorkstreamServerPayload` (client inbound) /
`validateWorkstreamClientMessage` (broker inbound). Types + vocabularies:
`workstreams.ts` (shared with schema migration 0003 CHECKs).

**[X2] identity discipline:** payloads carry harness session ids, file
paths, and placeholder labels ONLY. Native session ids NEVER ride this
channel — a node payload that even CARRIES the key is rejected (the §12
account-key precedent); the native id is a nullable STORE attribute. Brief
bodies carry paths + session ids + labels only (producer duty, the frozen
approvals-summary rule).

### 16.1 Broker → client (fan-out, journaled §8)

| Kind | Semantics |
|---|---|
| `workstream-list-snapshot` | the workstream rail: `capturedAt`, `workstreams: WorkstreamSummary[]`, `detachedNodeCount` (the detached-HEAD orphan bucket size) |
| `workstream-detail-snapshot` | one graph: `scope ∈ workstream · detached`; scope `workstream` REQUIRES the `workstream` summary, `detached` FORBIDS it (the §10.1 matrix precedent); `nodes[]` + `edges[]` |
| `workstream-node` | node UPSERT keyed on `sessionId` (fires on add AND attribute change) |
| `workstream-edge` | edge APPEND keyed on `edgeId` — edges are immutable once recorded |
| `workstream-brief` | a brief body: `briefId`, `briefKind ∈ session-end · pre-compact · session-start-injection · merge`, `body` (markdown, non-empty), `sourceSessionIds` (non-empty), `provenance ∈ native-summary · local-draft · refined`, `createdAt`, `workstreamId?` |
| `branch-advisory` | the context-pressure "branch now" proposal: `sessionId`, `contextUsedPct` (0..100 validated, the honesty-pin rule), `ts`. The ~70% threshold is broker configuration; the EVENT is the contract |
| `workstream-merge-resolved` | merge landed: `mergeId`, `sessionId` (the NEW node), `briefId` |

`WorkstreamSummary = { workstreamId, title, status ∈ active·paused·merged·
archived·abandoned, tags?, nodeCount, updatedAt }`. Node records carry
`{ sessionId, workstreamId? (absent = detached bucket), backend, account
(pairing-validated), state ∈ running·idle·completed·abandoned·unresumable·
external, origin ∈ harness·reconciled, confidence ∈ recorded·inferred,
displayName?, cwd?, gitBranch?, tokensIn?, tokensOut?, costEstimatedUsd?
(always an ESTIMATE), createdAt, lastActiveAt? }`. Edge records carry
`{ edgeId, fromSessionId?, toSessionId, edgeType, briefId?, confidence,
ts }` with the frozen edge vocabulary **exactly**
`continue · fork · merge_parent · compact · sidechain · handoff · import ·
workflow`; `fromSessionId` REQUIRED except `import` (FORBIDDEN there);
`handoff` REQUIRES `briefId` (context travels by brief); a `continue` edge
may be a self-edge (in-place resume) — a continuation is a CHILD, never a
sibling.

**Forward-tolerant reader rule (frozen, the §13.3 rule applied verbatim):**
a broker push whose `kind` is a non-empty string outside the frozen set is
legal and MUST be ignored by clients — M5 lineage lenses land without
breaking M4 clients. Registered kinds validate strictly; kindless payloads
answer `bad-request`. Producers must emit registered kinds only
(`publishWorkstream` refuses unregistered kinds — tolerance is a READER
rule).

### 16.2 Client → broker: `workstream-merge-request`

The ONE lineage verb the FE sends (the approvals-decision precedent: a
session-scoped verb rides its fan-out channel, not `control`):

```jsonc
{ "kind": "workstream-merge-request",
  "mergeId": "mrg_01",                  // client-generated, [A-Za-z0-9_-]{1,128}
  "params": {
    "parents": ["ses_a", "ses_b"],      // 2..16 DISTINCT harness session ids
    "accountLabel": "MAX_A",            // where the merge node runs [X2]
    "backend": "claude_code",           // must satisfy the label pairing
    "cwd": "/abs/path",
    "purpose": "…",
    "briefBody": "…",                    // REQUIRED non-empty markdown — the human-approved,
                                         // conflict-surfacing merge brief (blueprint §5:
                                         // merge = synthesis, not concatenation)
    "workstreamId": "ws_…" } }           // optional assignment
```

Drafts flow to the FE editor as `workstream-brief` payloads (provenance
`local-draft`/`refined` — the qwen-produces/Claude-reviews split); the wire
carries the FINAL text.

### 16.3 Merge flow

Broker validates → BE-7 engine records ONE new node with N `merge_parent`
edges + the merge brief ATOMICALLY (schema `recordMerge`) → the broker fans
out `workstream-merge-resolved` (correlated by `mergeId`) plus the node/edge
upserts to every client.

### 16.4 Merge error contract (frozen)

Failures answer PUSHED errors (§7) with `correlatesTo: mergeId` and
`channel: "workstream"`:

| Code | Class |
|---|---|
| `bad-request` | shape violations (parent count/dupes, pairing, relative cwd, blank purpose/brief) |
| `session-not-found` | a named parent has no session node — ALSO the degrade answer of a broker with no lineage engine composed (an empty broker has no nodes; the approvals empty-broker posture) |
| `workstream-not-found` | the named `workstreamId` is unknown (new code, §7) |
| `internal` | engine failure; message GENERIC [X2] |

### 16.5 Snapshot delivery

Same posture as the §13 read models: the broker pushes list/detail
snapshots on boot and on change, so a client replaying from seq 0 (or from
its watermark) always finds a fresh snapshot inside the bounded journal
window; below-floor history is unrecoverable by design and the next
snapshot re-baselines the view.

## 18. `pipelines` payloads — FROZEN (M5)

The features-4/5 feed (blueprint §7, plan §4/BE-8, §5/FE-6, findings
[pipeline-workflow-builder.md](../research/findings/pipeline-workflow-builder.md)
§R1/§R3). Bidirectional like `approvals`/`workstream`; replayable (§8).
Validators: `validatePipelineServerPayload` (client inbound) /
`validatePipelineClientMessage` (broker inbound). Types + vocabularies:
`pipelines.ts`. The versioned JSON DAG document the verbs carry is its own
contract, [dag-schema.md](dag-schema.md). **[X2] identity discipline:** payloads
carry file paths, content hashes, harness ids, capability NAMES, and placeholder
account labels ONLY — never native session ids (the event-summary/workstream
precedent), never real emails/account-ids/tokens. Per-step cost is an ESTIMATE
unless a field is explicitly labeled actual.

### 18.1 Broker → client (fan-out, journaled §8)

| Kind | Semantics |
|---|---|
| `catalog-snapshot` | the builder palette for one (workspace, account) resolution: `capturedAt`, `workspace?`, `entries: CatalogEntry[]`. Fired on boot and on FSEvents change (mirrors the CLI's live-reload) |
| `pipeline-run-snapshot` | one run's full monitor state: `capturedAt`, `run: PipelineRunStatusRecord`, `steps: PipelineStepStatusRecord[]`. Pushed on boot/subscribe and on rebuild |
| `pipeline-run-status` | a run-level status transition (upsert keyed on `runId`) |
| `pipeline-step-status` | a per-step-attempt transition (upsert keyed on `runId`+`stepId`+`iteration`+`attempt`) |
| `pipeline-validation-result` | the answer to a `pipeline-validate` verb: `requestId`, `valid`; on failure `issueCode`/`issueMessage`/`issuePath?` (the dag-schema.md §4 issue class). Validation failure is a NORMAL answer, NOT an error envelope |
| `pipeline-saved` | the answer to a `pipeline-save` verb: `requestId`, `pipelineId` |

`CatalogEntry = { capId, kind ∈ skill·command·agent·workflow·oc-agent·
oc-command·plugin, name, scope ∈ enterprise·user·project·plugin·
opencode-global·opencode-project, backendFamily ∈ claude·opencode, workspace?,
sourcePath (absolute), contentHash (sha256:…), slash?, argumentHint?,
disableModelInvocation?, accounts? }` — the normalized scanner record (findings
§R1), paths+names+labels only [X2]. The parsed frontmatter is DELIBERATELY NOT
on the wire (it can carry arbitrary user keys; the palette needs only the
invocation surface).

`PipelineRunStatusRecord = { runId, pipelineId, state ∈ pending·running·paused·
completed·failed·cancelled, schemaHash?, costEstimatedUsd?, startedAt?,
finishedAt?, resumable? }` (`resumable` drives the resume-from-journal
affordance). `PipelineStepStatusRecord = { runId, stepId, iteration, attempt,
state ∈ pending·blocked·running·awaiting-approval·completed·memoized·failed·
skipped·cancelled, sessionId? (the spawned node — the `workflow` lineage edge
target), account?, costEstimatedUsd?, tokensIn?, tokensOut?, startedAt?,
finishedAt?, errorKind? }`. `memoized` = resumed from the journal WITHOUT
re-execution (the M5 DoD); `awaiting-approval` = paused on a first-class
`approval` gate (the gate itself rides the approvals channel §10.1).

**Forward-tolerant reader rule (frozen, the §13.3 rule applied verbatim):** a
broker push whose `kind` is a non-empty string outside the frozen set is legal
and MUST be ignored by clients (decoded opaque). Registered kinds validate
strictly; kindless payloads answer `bad-request`. Producers emit registered
kinds only (tolerance is a READER rule).

### 18.2 Client → broker: the pipeline verbs

The six verbs the FE sends (the §16.2 merge-request precedent: a feature-scoped
verb rides its fan-out channel, not `control`). Each carries a client-generated
`requestId` (`[A-Za-z0-9_-]{1,128}`) and is answered by a payload/pushed error
correlated on it.

| `kind` | Params | Semantics |
|---|---|---|
| `pipeline-validate` | `document` (a DAG doc) | static validation, no run; answered by `pipeline-validation-result` |
| `pipeline-save` | `document` | persist a definition; answered by `pipeline-saved` |
| `pipeline-launch` | EXACTLY ONE of `pipelineId` \| `document`; `inputs?`; `workstreamId?` | start a run; per-step account routing rides the DAG (the [X1] differentiator) |
| `pipeline-pause` | `runId` | pause a running walk (in-flight steps finish; no new steps start) |
| `pipeline-resume` | `runId` | resume FROM THE JOURNAL — completed steps return cached output, never re-executing |
| `pipeline-cancel` | `runId` | abort a run; all in-flight steps aborted, child process groups reaped (findings §R3) |

`pipeline-validate`/`pipeline-save` carry a parseable DAG document on the wire;
a structurally-invalid document is a `bad-request` shape error on the VERB
(the validation-result payload reports the issue class for `pipeline-validate`).

### 18.3 Approval gates ride the approvals channel (no new wire)

A pipeline `approval` step (dag-schema.md §2) pauses the walk; the pending gate
is an `approval-request` with `source: 'workflow-gate'` on the EXISTING
`approvals` channel (§10.1: `runId`/`stepId` REQUIRED, `toolName`/`toolUseId`
forbidden) — the M2 one-inbox precedent. The FE answers `approval-decision`;
the broker fans out `approval-resolved`. No pipelines-channel gate payload
exists by design.

### 18.4 Error contract (frozen)

Verb failures answer PUSHED errors (§7) with `correlatesTo: requestId` and
`channel: "pipelines"`:

| Code | Class |
|---|---|
| `bad-request` | shape violations (malformed verb/params, invalid DAG document on validate/save, launch naming both/neither pipelineId+document) |
| `pipeline-not-found` | a launch named a `pipelineId` with no saved definition |
| `pipeline-run-not-found` | a pause/resume/cancel named an unknown `runId` |
| `pipeline-invalid` | a launch/save DAG document failed static validation (detail rides the validation-result payload; the error is GENERIC [X2]) |
| `step-not-found` | a referenced step id is absent from the run's document |
| `internal` | engine failure; message GENERIC [X2] |

### 18.5 Snapshot delivery + lineage/cost seams

Same posture as §13/§16.5: the broker pushes catalog + run snapshots on boot
and on change; a client replaying from its watermark always finds a fresh
snapshot inside the bounded journal window. **Lineage:** each step attempt =
a `session_node` with `workflow` `session_edge`s to its successors — recorded by
the pipeline runner (BE-8) directly on the lineage store (NOT via the
`LineageRecorder` port §15.1, which is for kernel session actions) and published
through the shared workstream publisher (dag-schema.md §6). **Cost:** per-step
cost lands in the events store via the `(backend, raw_ref)` dedupe key
([sqlite-ddl.md §7.2](sqlite-ddl.md)), `raw_ref` keyed
`pipeline:<runId>:<stepId>:<iteration>` — verified sufficient at this freeze, no
schema change.

## 19. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1-CORE freeze | — (the freeze itself) |
| 2026-07-04 | §4.2: optional `prompt` on resume params (sdk substrate requires it at M1); §4.1: launch `state` = ledger state at response time (M1 composition note). Additive, backward-compatible — old resume frames stay valid. | [ICR-0004](icr/icr-0004-resume-prompt.md) |
| 2026-07-04 | **M2 FULL FREEZE.** Promoted: transcript (§9), approvals (§10), quota (§11), context-graph (§12) payload unions; JSON reconnect-replay + per-(boot, channel) seq scoping (§2/§8); auth transport codified as connect-time token, handshake-message draft resolved as not needed (§1). Amended frozen surfaces (recorded here, landed by the freeze agent): error code `approval-not-pending` added (§7); `approve` verb retired-as-reserved — decisions ride the approvals channel (§4); §3 directions concretized (broker→client fan-out channels accept the client `replay-request`). Deferred: `events` payload union → M3 (§8). Protocol `1.0.0-m1-core` → `1.0.0`. FE-ORCH co-sign: **co-signed (M4 review)** — validator-derived, additive except the recorded amendments; FE client golden-corpus round-trips + the M2 payload-union suites verified green. | — (M2 freeze) |
| 2026-07-04 | §6 **attach-semantics behavior pin** (prose only, NO wire change, requested in the BE-3 M2 return): OUTPUT frames for `pty.<sid>` flow to a connection only after its first `pty-replay-request` on that channel — the replay-request doubles as the attach verb (`fromWatermark` 0 = from session birth); never-attached connections receive nothing and pin nothing; clients must replay-request on every (re)connect. Matches the landed BE-3 implementation and the FE-2 client's documented duty; golden fixtures unaffected. FE-ORCH co-sign: **co-signed (M4 review)** — the FE client implements the duty (first `pty-replay-request` sent immediately on openPty-while-connected + on every (re)connect; asserted in `app/src/lib/ws/wsClient.spec.ts`). | — (BE-ORCH steward, prose pin) |
| 2026-07-04 | **M3 FREEZE.** Closed the one open surface: the `events` payload union (§13) — `event-summary` (normalized events-store row fan-out, value-light [X2]) + `read-model-snapshot` (the ten §6.3 dashboard leads with a REQUIRED per-source freshness field; degraded sources are states, never errors) + the frozen forward-tolerant unknown-kind rule (§13.3, the M2 opaque policy made permanent). New closed registries: `EVENT_SOURCES`, `SOURCE_FRESHNESS_STATES`, `EVENT_ERROR_KINDS`, `READ_MODEL_IDS` (shared with schema migration 0002 CHECKs). Verified sufficient, NO amendment: quota snapshot (§11) carries the statusline tee data exactly (five_hour/seven_day → 5h/7d, usedPct, resetsAt); context-graph touch (§12) stays paths+session-ids only [X2]. Corpus: `events-payload` stage added; fixture `events-broker-payload-draft-opaque` kept byte-identical and valid, its pinned stage moved channel-policy→events-payload (the deferral resolving as recorded at M2); 19 new events fixtures (valid per read model + every invalid class). Protocol `1.0.0` → `1.1.0`, `FROZEN-M2` → `FROZEN-M3`. No new error codes; no change to any M1/M2 wire shape. FE-ORCH co-sign: **co-signed (M4 review)** — the freeze-literal advance replayed green (the pin now reads FROZEN-M4, reached through FROZEN-M3); events union consumed by the FE-5 dashboards under the forward-tolerant reader rule, golden-corpus suites green on both sides. | — (M3 freeze) |
| 2026-07-04 | §12 **session-id relay pin** (prose only, NO wire change; requested in the BE-6 M3 return): `sessionId` documented as harness-id-where-known with native-id relay until the BE-7/M4 ledger mapping — the exact hooks-contract §7 approvals-relay sentence, now stated for context-graph too; the composition root MUST inject the ledger resolver at M4 (the `resolveSessionId` seam, core/src/collector/graphfeed/hookTouches.ts). Validator, charset and golden fixtures unchanged. FE-ORCH co-sign: n/a (no wire change). | — (BE-ORCH steward, prose pin) |
| 2026-07-04 | **M4 FREEZE.** New: the `workstream` channel (§16) — broker→client lineage fan-out (`workstream-list-snapshot` / `workstream-detail-snapshot` with the scope matrix / `workstream-node` upserts / `workstream-edge` appends with the frozen edge vocabulary `continue·fork·merge_parent·compact·sidechain·handoff·import·workflow` and the from/import + handoff-brief matrices / `workstream-brief` / `branch-advisory` / `workstream-merge-resolved`) + the client `workstream-merge-request` (2..16 distinct parents, mandatory conflict-surfacing `briefBody`) with its frozen error contract (§16.4); the same forward-tolerant unknown-kind reader rule as events §13.3; native ids REJECTED on the wire [X2]. Lineage seams frozen as port types (§15): `LineageRecorder` (launch/resume/fork/recycle/merge recorded AT ACTION TIME — the M2 `ContinuationEdgeEmitter` stub generalized; continuation = CHILD, in-place carries from === to) and `SessionIdResolver` (the §12 pin resolved). Amended frozen surfaces (recorded here, landed by this freeze agent): §3 channel registry + `workstream` (bidirectional, the approvals precedent); §8 replayable set + `workstream`; §7 error code `workstream-not-found`. Gateway/FE wiring seams landed via [ICR-0011](icr/icr-0011-gateway-workstream-slice.md) (gateway `WorkstreamEnginePort` + validated routing/publisher + absent-engine degrade; FE inbound-router workstream branch). Corpus: `workstream-payload` + `workstream-client-message` stages, one valid frame per kind + every invalid class; no existing fixture changed. Protocol `1.1.0` → `1.2.0`, `FROZEN-M3` → `FROZEN-M4`. No change to any M1–M3 wire shape. FE-ORCH co-sign: **co-signed (M5 review)** — the freeze-literal advance in `app/src/features/launch/wire.spec.ts` now pins `FROZEN-M5` (reached through `FROZEN-M4`) and the FE inbound-router `workstream` branch (`app/src/lib/ws/inboundRouter.ts`, opaque-tolerant `validateWorkstreamServerPayload`) both replay green; the FE golden-corpus round-trip (`app/src/lib/ws/goldenCorpus.spec.ts`, every `workstream` frame) is green on the FE side. | — (M4 freeze) |
| 2026-07-04 | **M5 FREEZE.** New: the `pipelines` channel (§18) — broker→client catalog + run-monitor fan-out (`catalog-snapshot` [the builder palette; paths+names+labels only, X2] / `pipeline-run-snapshot` / `pipeline-run-status` / `pipeline-step-status` [per-step cost reference + the `memoized` resume-from-journal state] / `pipeline-validation-result` / `pipeline-saved`) + the six client verbs `pipeline-validate\|save\|launch\|pause\|resume\|cancel` with the frozen error contract (§18.4); the same forward-tolerant unknown-kind reader rule as events §13.3 / workstream §16.1; native ids REJECTED on the wire [X2]. Approval GATES ride the EXISTING approvals channel via the frozen `workflow-gate` source (§10.1, §18.3) — no new gate wire (the M2 one-inbox precedent). The versioned JSON DAG document the verbs carry is its own new contract [dag-schema.md](dag-schema.md) (FROZEN-M5 v1: step kinds prompt·skill·agent·workflow-script·approval, needs/when/forEach/loop, per-step account/budget/retry/outputSchema, the forward-INCOMPAT rule for schemaVersion + step kind). New closed registries: `CAPABILITY_KINDS`, `CATALOG_SCOPES`, `CAPABILITY_BACKEND_FAMILIES`, `PIPELINE_RUN_STATES`, `PIPELINE_STEP_STATES`, `PIPELINE_CLIENT_VERBS` (pipelines.ts). Amended frozen surfaces (recorded here, landed by this freeze agent): §3 channel registry + `pipelines` (bidirectional); §8 replayable set + `pipelines`; §7 error codes `pipeline-not-found`/`pipeline-run-not-found`/`pipeline-invalid`/`step-not-found`. Verified sufficient, NO amendment: the `workflow` edge type (already in the frozen §16 edge vocabulary since M4) + the events `(backend, raw_ref)` dedupe key carry the per-step-attempt lineage + cost seams (dag-schema.md §6, §18.5); the LineageRecorder port (§15.1) is correctly scoped to kernel actions — the pipeline runner records `workflow` edges directly. Corpus: `pipelines-payload` + `pipelines-client-message` stages, one valid frame per kind + each verb + every invalid class; no existing fixture changed. Protocol `1.2.0` → `1.3.0`, `FROZEN-M4` → `FROZEN-M5`. No change to any M1–M4 wire shape. FE-ORCH co-sign: **co-signed (M5 review, 2026-07-05)** — the one-line freeze-literal advance in `app/src/features/launch/wire.spec.ts` pins `FROZEN-M5` and the FE inbound-router `pipelines` branch (forward-tolerant `validatePipelineServerPayload`) both replay green; the FE golden-corpus round-trip (`app/src/lib/ws/goldenCorpus.spec.ts`, 114/114 incl. every `pipelines` frame + each of the six verbs) is green (record: [m5-dod.md](../runbooks/m5-dod.md) §6). | — (M5 freeze) |
