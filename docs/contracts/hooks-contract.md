# Hooks contract — http-hook POSTs the collector accepts

> ## 🔒 FROZEN-M2 — 2026-07-04
> **Owner: BE-ORCH · Co-sign: SI-ORCH** (SI-3 authors the per-account hook
> settings templates that must POST exactly this shape; BE-5 implements the
> accepting collector at M3). After this banner, this contract changes
> **only** through an interface change request
> ([docs/contracts/icr/](icr/README.md)). **This document is the prose of
> record when templates/collector and prose disagree — file an ICR, never a
> silent divergence.**

Blueprint anchors: §4.1 (semantics never come from PTY bytes — hooks are feed
(b); the two-layer permission relay's policy floor; the context-graph feed),
§6.1 (collection matrix), plan §6/SI-3 (hook settings templates), plan
§4/BE-5 (collector), §9.3 BE↔SI #3.

Scope: the **`type:"http"` hook POST** surface only. The statusline quota tee
(stdin JSON → per-account file) is a separate SI-3 template concern feeding
the `quota` channel ([ws-protocol.md §11](ws-protocol.md)); OTel env blocks
are SI-3 configuration feeding the OTLP receiver. Neither is part of this
contract.

---

## 1. Endpoint — the versioned envelope

```
POST http://127.0.0.1:<hooksPort>/hooks/v1/<ACCOUNT_LABEL>
Content-Type: application/json
```

- **The HTTP request IS the envelope; its version rides the path** (`/v1/`).
  Body-field evolution within v1 is additive-only; any breaking change is
  `/hooks/v2/` plus an ICR, with v1 accepted through a deprecation window.
- **`<ACCOUNT_LABEL>` comes from the hook settings template — NEVER derived
  from identity.** SI-3 installs one settings template per account config
  dir, and the only difference between templates is this baked-in path
  segment (`MAX_A` / `MAX_B` / `ENT` / `AWS_DEV` / `LOCAL` — placeholder
  labels only [X2]). The collector attributes the event to the label in the
  path and to nothing else: it MUST NOT infer the account from
  `transcript_path`, `cwd`, env, or any body content.
- `<hooksPort>` is loopback-only collector configuration (BE-5; default
  `4319`, adjacent to the `4318` OTLP receiver, overridable via
  `AIBENDER_HOOKS_PORT`). The port value is configuration; the path and
  payload shapes are the frozen contract.

## 2. Body — native hook input, field names as the CLI emits them

The body is the hook's **stdin input JSON forwarded verbatim** — the
contract deliberately adopts the Claude Code hook field vocabulary
(snake_case) instead of inventing a mapping layer, so a template is nothing
more than a URL:

```jsonc
{
  "hook_event_name": "PreToolUse",       // REQUIRED — see the vocabulary (§3)
  "session_id": "<native session id>",   // REQUIRED
  "transcript_path": "/abs/path.jsonl",  // standard on session-scoped events
  "cwd": "/abs/workdir",
  "permission_mode": "default",
  // tool events additionally:
  "tool_name": "Read",
  "tool_input": { ... },
  "tool_use_id": "toolu_…",
  "tool_output": { ... }                 // PostToolUse-family only
  // …other event-specific fields pass through untouched
}
```

Acceptance rules (collector, M3):

| Condition | Response |
|---|---|
| endpoint auth configured (§4.2) **and** the `x-aibender-hook-token` header is missing/repeated/mismatched | **401** — rejected *before any parse/insert/relay*; precedes even the 404 label check (no label oracle). Not emitted when auth is unconfigured (the default) |
| well-formed JSON object with `hook_event_name` + `session_id` strings | **204** accepted (no body) — including **unknown** event names, which are parked as `unmapped` rather than rejected (the CLI adds events in minor bumps; ingestion must not break on a vocabulary bump) |
| gating-capable event the policy floor has an opinion on (§4.1) | **200** + JSON hook output |
| unknown `<ACCOUNT_LABEL>` path segment | **404** — never a guess |
| unparseable body / missing required fields | **400** — the collector logs a redacted line; the session is unaffected |

The collector answers **fast** (target <50 ms) and never applies
backpressure to sessions; templates set a short hook timeout so a dead
collector can never stall a session (fire-and-forget posture, §9.2 BE-5:
"malformed line skipped, tail continues").

**[X2] at ingest:** body content may inherently carry machine-local paths
(fine — nothing leaves the machine) but identity attributes (emails,
org/account UUIDs) are **dropped or mapped to labels at ingest** — nothing
identity-bearing enters the events store (blueprint §6.2). Attribution comes
only from the path label (§1).

## 3. Event vocabulary (aligned with the ~30-event Claude Code hook set)

The v1 vocabulary the collector maps (everything else → `unmapped`, still
accepted). Source of record for the upstream set:
[harness-architecture findings](../research/findings/harness-architecture.md)
(2026 hook reference).

| Group | `hook_event_name` values | Primary consumer |
|---|---|---|
| Session lifecycle | `SessionStart` · `SessionEnd` · `Setup` | BE-7 [X4] automation (`SessionStart` matchers `startup\|resume\|clear\|compact`; `SessionEnd` → continuation brief) |
| Prompt lifecycle | `UserPromptSubmit` · `UserPromptExpansion` · `Stop` · `StopFailure` | events store |
| Tool lifecycle | `PreToolUse` · `PostToolUse` · `PostToolUseFailure` · `PostToolBatch` | events store; context graph (`read`/`write` touches → [ws-protocol.md §12](ws-protocol.md)) |
| Permission floor | `PermissionRequest` · `PermissionDenied` | approvals relay, source `hook-floor` ([ws-protocol.md §10](ws-protocol.md)) |
| Subagents/teams | `SubagentStart` · `SubagentStop` · `TeammateIdle` · `TaskCreated` · `TaskCompleted` | lineage (`sidechain` edges), events store |
| Context/files | `FileChanged` · `CwdChanged` · `InstructionsLoaded` · `ConfigChange` · `WorktreeCreate` · `WorktreeRemove` | context graph (`watched` / `instructions` touches); reconciler |
| Compaction | `PreCompact` · `PostCompact` | BE-7 [X4] (`compact` edges, full-fidelity snapshot) |
| UX surfaces | `Notification` · `MessageDisplay` · `Elicitation` | events store |

Hooks cover **harness-launched AND external sessions** — the account-wide
settings template fires for every session in that config dir, which is
exactly why the context graph and the reconciler see sessions the harness
did not spawn (blueprint §4.1).

## 4. Endpoint responses (policy floor + authentication)

### 4.1 Gating responses (the permission policy floor)

For gating-capable events (`PermissionRequest`, `PreToolUse`), a `200`
response body is hook output in the CLI's own schema, e.g.:

```jsonc
{ "permissionDecision": "deny",
  "permissionDecisionReason": "blocked by harness policy floor" }
```

- The collector's DEFAULT is **204 — no opinion** (the native permission flow
  proceeds; SDK sessions still get the in-loop `canUseTool` relay,
  ws-protocol.md §10 source `can-use-tool`).
- When the floor escalates to the human instead of auto-deciding, the broker
  raises an `approval-request` with source `hook-floor` on the approvals
  channel and the collector answers within the hook timeout with the decision
  if one arrives in time, else 204.
- **T3 verification item (SI-3 install, milestone gate):** the exact CLI-side
  interpretation of http-hook response bodies for `permissionDecision` must
  be verified against the pinned CLI version on the real host before the
  floor is switched from observe-only to enforcing (plan §9.4 posture). The
  REQUEST shape above is frozen either way.

### 4.2 Endpoint authentication — the per-install token gate (SEC-3)

The hooks endpoint is **internal-only**: it binds loopback (`127.0.0.1`) and is
never exposed off-host. That bind stops off-box traffic but NOT other local
processes — any process on the machine can reach `127.0.0.1:<hooksPort>` and
POST forged `PermissionRequest`/`SessionEnd`/`PreCompact` events into the
approval floor and the session ledger. SEC-3 closes that **local-process
spoofing** gap with an OPTIONAL per-install token:

- **The gate.** `HooksServerOptions.authToken` (collector). When set, EVERY
  POST must present the token in the **`x-aibender-hook-token`** header
  (`HOOK_TOKEN_HEADER`, constant-time compared) or it is rejected **`401`
  before any body parse, normalization, events-store insert, or approval-floor
  relay**. The 401 precedes even the 404 unknown-label check, so a token-less
  caller gets no path/label oracle. Missing, repeated (`string[]`), or
  mismatched header → 401.
- **Off by default = the open posture.** ABSENT `authToken` keeps the M2–M6
  behavior exactly (loopback-only, no header demanded); the guard is a no-op.
  This is the back-compat default until the T3 proof below lands.
- **The token is a STABLE per-install secret — NOT per-boot.** SI-3 mints it
  once (32-byte base64url, the gateway-token shape) to
  `$AIBENDER_HOME/hook-token` (0600) and, under `install --hook-token`, stamps
  the matching header onto every loopback hook entry in each account's
  `settings.json`. The broker (BE-MAIN) READS that same file at boot and passes
  the value as `authToken`. A per-boot token could never match a header baked
  into on-disk settings, so per-boot is explicitly wrong here. One shared secret
  serves all accounts (the endpoint is one server with one `authToken`), so it
  does **not** widen the `<LABEL>`-only per-account delta (§1). It is kept
  **distinct** from the per-boot WS gateway token (which lives in the gateway
  bootstrap file).
- **Threat model — local spoofing, not network exposure.** The loopback bind is
  preserved either way; the token is defense-in-depth against a co-resident
  local process, NOT a substitute for network controls and NOT a firewall
  concern. *(This supersedes the network-exposure framing of the original SEC-3
  write-up.)*
- **T3 verification item (SI-3 install, milestone gate).** Whether the pinned
  CLI forwards a custom request header on a `type:"http"` hook — and does not
  reject the unknown `headers` key — is UNVERIFIED, the same class as the §4.1
  gating and §7.1 injection CLI-response items. It MUST be verified against the
  pinned CLI on the real host before `authToken` is switched on in production;
  until then both the SI-3 header injection (opt-in) and the collector gate stay
  OFF and the endpoint keeps its open, loopback-only posture. The REQUEST shape
  (the header name + the 401 class) is frozen either way.

## 5. Template obligations (SI-3)

1. One settings template per account config dir; the ONLY per-account
   difference is the `<ACCOUNT_LABEL>` path segment (§1).
2. Hook registrations POST to `/hooks/v1/<LABEL>` with a short timeout;
   installs are idempotent and preserve unrelated user settings (plan §9.2
   SI-3 edge row).
3. Templates never register hooks that write anywhere except the loopback
   POST (no shell-outs that could leak identity into the tree [X2]).
4. The [X4] automation set (`SessionStart`/`SessionEnd`/`PreCompact`) is part
   of the same template — BE-7 consumes those events from the store, not via
   a second transport.
5. **SEC-3 endpoint auth (opt-in, §4.2).** Under `install --hook-token`, every
   loopback hook entry additionally carries the `x-aibender-hook-token` header
   whose value is the stable per-install secret at `$AIBENDER_HOME/hook-token`
   (0600), shared with the broker's `authToken`. **OFF by default** (a plain
   install is byte-identical to the open posture) and T3-gated (§4.2). The
   header rides the *same* loopback POST — it adds no transport and no shell-out
   (§5.3) — and the token is one shared secret across all accounts, so the
   per-account delta stays `<LABEL>`-only (§1). A normal uninstall removes the
   header with the aibender hook entries; the secret file is shared machine
   state, removed only by `uninstall --purge-shared`.

## 6. Fixtures — LANDED (M3)

Synthesized hook-POST fixtures (bodies per §2, labels per [X2] fixture
policy) live in `packages/testkit` as **`GOLDEN_HOOK_FIXTURES`** (+
`replayGoldenHookFixture`, `GOLDEN_HOOK_CORPUS_FREEZE = 'FROZEN-M3'`) — the
same corpus-and-replay device the WS protocol uses (`GOLDEN_WS_FIXTURES`
precedent, ICR-0003). Every acceptance class is pinned as exact body bytes:
gating-capable accepts (with the relay slice), non-gating accepts,
unknown-event `unmapped` accepts, 404 label rejections (incl. case
sensitivity), and every 400 class (missing fields, non-object, unparseable).
BE-5's collector replays these against its real HTTP handler; SI-3 templates
validate against the same shapes.

## 7. Acceptance-side types — FROZEN (M3, `packages/protocol`)

This contract pinned the accepting collector to BE-5/M3; the M3 freeze lands
the types BE-5 and the gateway agree on, in `packages/protocol` (`hooks.ts`):

- **Envelope validation result** — `validateHookPost(accountSegment, body)`
  → `HookPostOutcome`: `{ ok: true, accepted: AcceptedHookPost }` or a typed
  rejection (`unknown-label`/404, `malformed-body`/400) exactly per the §2
  table. `AcceptedHookPost` carries the label (FROM THE PATH ONLY [X2]), the
  event name, the native session id, the §3 vocabulary group (`unmapped` for
  unknown names — still accepted), the gating capability, and the body
  **verbatim** (unknown keys pass through, per §2 — the one deliberate
  exception to the WS validators' sanitize-to-contract-keys rule).
- **Ack shape** — `HookAck`: `204` (accepted, no opinion — the default) ·
  `200 + HookGatingOutput` (`permissionDecision` ∈ `allow·deny·ask`, CLI
  schema per §4) · `404` · `400`. `ackForHookOutcome` enforces that a gating
  output is only ever attached to an ACCEPTED, GATING-CAPABLE post
  (`PermissionRequest`/`PreToolUse`, `GATING_CAPABLE_HOOK_EVENTS`) — a buggy
  floor can never gate `SessionEnd`.
- **PermissionRequest → hook-floor relay contract** —
  `hookFloorRelayInput(accepted)` → `{ accountLabel, nativeSessionId,
  toolName, toolUseId? }` or `undefined` (not gating-capable, or no
  `tool_name` to summarize [X2]). The broker maps the native session id to a
  harness id where the ledger knows one, else relays the native id (the
  approvals-wire sessionId charset admits both), and raises the
  `approval-request` with source `hook-floor`
  ([ws-protocol.md §10.1](ws-protocol.md)).
- The §3 vocabulary is machine-checkable as `HOOK_EVENT_VOCABULARY` (29
  names → 8 groups) + `mapHookEventName`; endpoint constants
  (`HOOK_PATH_PREFIX = /hooks/v1/`, `DEFAULT_HOOKS_PORT = 4319`,
  `HOOKS_PORT_ENV_VAR`) are exported alongside.

The §4 T3 verification item (CLI-side interpretation of `200` gating bodies
on the real host before the floor turns enforcing) is UNCHANGED by this
freeze — the REQUEST and ack shapes are frozen either way.

### 7.1 [X4] automation routing — FROZEN (M4, `packages/protocol`)

The §3/§5 [X4] automation rows resolve at M4 into a frozen ROUTING contract
between BE-5's accepting endpoint and BE-7's workstream handlers
(`hooks.ts` amendment; consumed with the lineage surfaces of
ws-protocol.md §15/§16):

- **Routing set** — `X4_AUTOMATION_HOOK_EVENTS = SessionStart · SessionEnd ·
  PreCompact`; `x4AutomationRouteFor(accepted)` names the handler slot for
  one ACCEPTED post (undefined = events-store-only, the M3 behavior).
  Routing happens AFTER `validateHookPost`; the body passes through
  VERBATIM (§2) — handlers see everything the CLI sent.
- **Handler port** — `WorkstreamHookRouting`, implemented by BE-7 and
  registered with the collector (all slots optional; an unregistered slot
  keeps the M3 events-store-only behavior):
  - `onSessionEnd(post)` → the auto continuation brief. **POST-ACK
    fire-and-forget**: the collector answers 204 FIRST and invokes the
    handler after — a slow or throwing handler can never stall or fail a
    session (the §2 <50 ms posture is unchanged; throws are logged and
    swallowed collector-side).
  - `onPreCompact(post)` → full-fidelity snapshot + `compact` edge.
    POST-ACK fire-and-forget, same rules.
  - `onSessionStart(post)` → the ONE handler whose output rides the HTTP
    response: the collector races it against a short deadline
    (configuration, the §4 floor-timeout pattern) and answers
    `200 + HookSessionStartOutput` when a value arrives in time, else 204.
    Returning undefined = no injection. The startup/resume/clear/compact
    policy is handler-side, decided from the body's `source` field.
- **SessionStart response shape (frozen)** — the CLI's own hook-output
  schema:

```jsonc
{ "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "…" } }   // non-empty markdown injected into the
                                   // session — the workstream's latest brief.
                                   // Paths + session ids + labels only [X2].
```

- **Ack discipline** — `ackForSessionStart(outcome, injection?)` mirrors
  the frozen `ackForHookOutcome` rule: an injection body is only ever
  attached to an ACCEPTED post whose event IS `SessionStart` (a buggy
  handler can never inject into a tool event); an empty
  `additionalContext` degrades to 204; rejections mirror their httpStatus.
  `HookAck`'s 200 body widened to `HookGatingOutput |
  HookSessionStartOutput` — additive, every M3 ack byte-identical.
- **T3 verification item (SI-3, milestone gate)** — like the §4 gating
  flag: the CLI-side interpretation of the SessionStart `200` body
  (`additionalContext` injection) must be verified against the pinned CLI
  on the real host before brief injection turns on. The RESPONSE shape is
  frozen either way; 204 remains the default until the proof lands.

Golden corpus: the hook fixtures now pin the route per accepted post
(`x4Route` on `GOLDEN_HOOK_FIXTURES`, `GOLDEN_HOOK_CORPUS_FREEZE =
'FROZEN-M4'`) — SessionStart (startup + resume), SessionEnd, PreCompact,
and non-automation accepts staying route-less.

## 8. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial FROZEN-M2 freeze: versioned `/hooks/v1/<LABEL>` envelope; native-vocabulary body with `hook_event_name`/`session_id` required; accept-unknown-events rule; label-from-template-only attribution [X2]; gating-response shape with the T3 verification flag. SI-ORCH co-sign: **co-signed (M4 review)** — SI-3 templates POST exactly this envelope: `/hooks/v1/<LABEL>` with the label as the ONLY per-account delta, the full 29-event vocabulary, http-only (no shell-outs [X2]), short timeouts, idempotent merge-never-overwrite installer — all pinned by the hooks bats suite (27/27 green, re-run at this review). | — (M2 freeze) |
| 2026-07-04 | **M3 acceptance-side freeze (§7):** typed POST validation outcome + ack shape + PermissionRequest→hook-floor relay contract landed in `packages/protocol` (`hooks.ts`); §3 vocabulary machine-checkable (`HOOK_EVENT_VOCABULARY`, 29 names/8 groups); golden hook-POST corpus landed in `packages/testkit` (§6, `GOLDEN_HOOK_FIXTURES`). No change to any §1–§5 shape — this freeze makes the M2 prose machine-checkable and pins the collector/gateway agreement surface. §4 T3 gating-verification flag unchanged. SI-ORCH co-sign: **co-signed (M4 review)** — the golden hook-POST corpus replays green against the real collector handler (every §2 acceptance class incl. 404 label case-sensitivity and each 400 class); the SI-3 template URL shape matches the frozen endpoint constants (`HOOK_PATH_PREFIX`, default port 4319) byte-for-byte, verified by the SI suites at this review. | — (M3 freeze) |
| 2026-07-05 | **SEC-3 endpoint-auth amendment (§2 table 401 row; §4→§4.1/§4.2; §5.5):** documents the OPTIONAL per-install token gate on the accepting endpoint — `HooksServerOptions.authToken` + the `x-aibender-hook-token` header, the `401`-before-parse reject class (precedes the 404 label check — no label oracle), the STABLE per-install secret (`$AIBENDER_HOME/hook-token`, SI-3-minted 0600, broker-read at boot) kept DISTINCT from the per-boot WS gateway token, OFF by default (the open loopback posture is preserved), and a local-process-spoofing threat model with the loopback bind preserved (the original SEC-3 firewall/network-exposure framing is dropped). New T3 item: pinned-CLI custom-`headers` forwarding must be proven before `authToken` turns on. No change to any §1–§3 REQUEST shape or the §7/§7.1 acceptance/routing types; the accepting collector already implements the gate (`core/src/collector/hooks/server.ts`, SEC-3 spec green) and SI-3 the header injection (`infra/hooks`, opt-in `--hook-token`, bats green). **Owning orchestrator BE-ORCH: ratification PENDING. SI-ORCH co-sign: PENDING.** | [ICR-0015](icr/icr-0015-hooks-endpoint-token.md) |
| 2026-07-04 | **M4 [X4] routing freeze (§7.1):** the SessionStart/SessionEnd/PreCompact automation routing contract landed in `packages/protocol` (`hooks.ts` amendment): `X4_AUTOMATION_HOOK_EVENTS` + `x4AutomationRouteFor`; the `WorkstreamHookRouting` handler port BE-7 registers with BE-5's endpoint (SessionEnd/PreCompact post-ack fire-and-forget; SessionStart deadline-raced); the frozen SessionStart injection response `HookSessionStartOutput` (`hookSpecificOutput.additionalContext`, CLI hook-output schema) + `ackForSessionStart` (injection only on accepted SessionStart posts; empty context → 204); `HookAck` 200 body widened additively. Hook corpus advanced to `FROZEN-M4` with per-fixture `x4Route` pins + SessionEnd/SessionStart(resume) fixtures. NEW T3 verification item: CLI-side `additionalContext` interpretation before injection turns on (204 stays the default). No change to any §1–§6 REQUEST shape. SI-ORCH co-sign: **co-signed (M5 review)** — the [X4] routing contract is proven end-to-end: the X4 routing e2e suite (`core/src/collector/hooks/x4Routing.spec.ts`, 8/8 green) exercises `x4AutomationRouteFor` over accepted posts (SessionStart injection deadline-race → `HookSessionStartOutput`/204, SessionEnd/PreCompact POST-ACK fire-and-forget, non-automation accepts route-less); the SI-3 hooks bats suite is 27/27 green (the per-account templates POST the frozen `/hooks/v1/<LABEL>` envelope carrying the full event vocabulary, re-run at this review); and the golden hook corpus pins `x4Route` per accepted post (`GOLDEN_HOOK_FIXTURES`, SessionStart startup+resume · SessionEnd · PreCompact, derived from the frozen `x4AutomationRouteFor`). No SI-authored request-side surface changed at M5. | — (M4 freeze) |
