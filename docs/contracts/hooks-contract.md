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
| well-formed JSON object with `hook_event_name` + `session_id` strings | **204** accepted (no body) — including **unknown** event names, which are parked as `unmapped` rather than rejected (the CLI adds events in minor bumps; ingestion must not break on a vocabulary bump) |
| gating-capable event the policy floor has an opinion on (§4) | **200** + JSON hook output |
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

## 4. Gating responses (the permission policy floor)

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

## 6. Fixtures

Synthesized hook-POST fixtures (bodies per §2, labels per [X2] fixture
policy) land in `packages/testkit` alongside BE-5's collector at M3 — the
same corpus-and-replay device the WS protocol uses (`GOLDEN_WS_FIXTURES`
precedent, ICR-0003). Until then the examples in this document are the
normative shapes.

## 7. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial FROZEN-M2 freeze: versioned `/hooks/v1/<LABEL>` envelope; native-vocabulary body with `hook_event_name`/`session_id` required; accept-unknown-events rule; label-from-template-only attribution [X2]; gating-response shape with the T3 verification flag. SI-ORCH co-sign: **pending**. | — (M2 freeze) |
