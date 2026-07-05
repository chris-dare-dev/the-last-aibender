/**
 * Hooks acceptance-side types — the machine-checkable half of
 * docs/contracts/hooks-contract.md (the `type:"http"` hook POST surface).
 * hooks-contract.md pins the ACCEPTING collector to BE-5/M3; this file
 * freezes the shapes BE-5's collector and the gateway (approvals relay)
 * must agree on:
 *
 *   1. the POST envelope validation outcome ({@link validateHookPost} —
 *      label-from-path-only attribution [X2], accept-unknown-events rule);
 *   2. the ack shape ({@link HookAck} — 204 no-opinion / 200 gating output /
 *      404 unknown label / 400 malformed);
 *   3. the PermissionRequest → hook-floor relay contract
 *      ({@link hookFloorRelayInput} — the slice the broker needs to raise an
 *      `approval-request` with source `hook-floor`, ws-protocol.md §10.1).
 *
 * NOT a WS surface: these types describe the loopback HTTP collector
 * (`POST http://127.0.0.1:<hooksPort>/hooks/v1/<ACCOUNT_LABEL>`). The body
 * passes through VERBATIM by contract (hooks-contract.md §2) — unlike the WS
 * validators, {@link AcceptedHookPost} deliberately retains unknown body keys.
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, SI-ORCH co-signs (SI-3 templates POST this shape).
 * Prose of record: docs/contracts/hooks-contract.md.
 * Amendments: M4 freeze — the [X4] automation routing slice
 * (hooks-contract.md §7.1, amendment-recorded): {@link X4_AUTOMATION_HOOK_EVENTS},
 * {@link x4AutomationRouteFor}, the {@link WorkstreamHookRouting} handler
 * port BE-7 registers with BE-5's accepting endpoint, the SessionStart
 * injection response shape ({@link HookSessionStartOutput}, CLI hook-output
 * schema `hookSpecificOutput.additionalContext`), and its ack builder
 * ({@link ackForSessionStart}). {@link HookAck}'s 200 body widened to
 * `HookGatingOutput | HookSessionStartOutput` — additive; every M3 ack stays
 * byte-identical.
 * ============================================================================
 */

import type { AccountLabel } from './vocab.js';
import { isAccountLabel } from './vocab.js';

// ---------------------------------------------------------------------------
// Endpoint constants (hooks-contract.md §1)
// ---------------------------------------------------------------------------

/** The versioned path prefix — the HTTP request IS the envelope. */
export const HOOK_PATH_PREFIX = '/hooks/v1/' as const;

/** Default loopback collector port (adjacent to the 4318 OTLP receiver). */
export const DEFAULT_HOOKS_PORT = 4319;

/** Env var overriding the collector port (configuration, not contract). */
export const HOOKS_PORT_ENV_VAR = 'AIBENDER_HOOKS_PORT' as const;

// ---------------------------------------------------------------------------
// Event vocabulary (hooks-contract.md §3) — everything else is `unmapped`
// ---------------------------------------------------------------------------

export const HOOK_EVENT_GROUPS = Object.freeze([
  'session-lifecycle',
  'prompt-lifecycle',
  'tool-lifecycle',
  'permission-floor',
  'subagents',
  'context-files',
  'compaction',
  'ux',
] as const);

export type HookEventGroup = (typeof HOOK_EVENT_GROUPS)[number];

/**
 * The v1 vocabulary the collector MAPS (hooks-contract.md §3). Unknown names
 * are STILL ACCEPTED (parked as `unmapped`) — the CLI adds events in minor
 * bumps and ingestion must not break on a vocabulary bump.
 */
export const HOOK_EVENT_VOCABULARY: Readonly<Record<string, HookEventGroup>> = Object.freeze({
  SessionStart: 'session-lifecycle',
  SessionEnd: 'session-lifecycle',
  Setup: 'session-lifecycle',
  UserPromptSubmit: 'prompt-lifecycle',
  UserPromptExpansion: 'prompt-lifecycle',
  Stop: 'prompt-lifecycle',
  StopFailure: 'prompt-lifecycle',
  PreToolUse: 'tool-lifecycle',
  PostToolUse: 'tool-lifecycle',
  PostToolUseFailure: 'tool-lifecycle',
  PostToolBatch: 'tool-lifecycle',
  PermissionRequest: 'permission-floor',
  PermissionDenied: 'permission-floor',
  SubagentStart: 'subagents',
  SubagentStop: 'subagents',
  TeammateIdle: 'subagents',
  TaskCreated: 'subagents',
  TaskCompleted: 'subagents',
  FileChanged: 'context-files',
  CwdChanged: 'context-files',
  InstructionsLoaded: 'context-files',
  ConfigChange: 'context-files',
  WorktreeCreate: 'context-files',
  WorktreeRemove: 'context-files',
  PreCompact: 'compaction',
  PostCompact: 'compaction',
  Notification: 'ux',
  MessageDisplay: 'ux',
  Elicitation: 'ux',
});

/** Map a hook event name to its group, or `unmapped` (still accepted). */
export function mapHookEventName(name: string): HookEventGroup | 'unmapped' {
  return HOOK_EVENT_VOCABULARY[name] ?? 'unmapped';
}

/**
 * Events the policy floor may answer with a gating output (hooks-contract.md
 * §4). `PermissionRequest` is the human-escalation path (→ hook-floor
 * approval); `PreToolUse` is the auto policy floor.
 */
export const GATING_CAPABLE_HOOK_EVENTS = Object.freeze([
  'PermissionRequest',
  'PreToolUse',
] as const);

export function isGatingCapableHookEvent(name: string): boolean {
  return (GATING_CAPABLE_HOOK_EVENTS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// POST validation outcome (hooks-contract.md §2 acceptance rules)
// ---------------------------------------------------------------------------

/** A hook POST the collector accepted (204/200 family). */
export interface AcceptedHookPost {
  /**
   * From the PATH SEGMENT ONLY — never derived from transcript_path, cwd,
   * env, or any body content [X2] (hooks-contract.md §1).
   */
  readonly accountLabel: AccountLabel;
  readonly hookEventName: string;
  /** The hook body's `session_id` — a NATIVE session id. */
  readonly nativeSessionId: string;
  readonly group: HookEventGroup | 'unmapped';
  readonly gatingCapable: boolean;
  /** The body VERBATIM — unknown keys pass through untouched (§2). */
  readonly body: Readonly<Record<string, unknown>>;
}

export type HookPostRejection =
  | { readonly reason: 'unknown-label'; readonly httpStatus: 404 }
  | { readonly reason: 'malformed-body'; readonly httpStatus: 400; readonly message: string };

export type HookPostOutcome =
  | { readonly ok: true; readonly accepted: AcceptedHookPost }
  | ({ readonly ok: false } & HookPostRejection);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate one hook POST exactly per the hooks-contract.md §2 table:
 *   - unknown `<ACCOUNT_LABEL>` path segment → 404, never a guess;
 *   - body not a JSON object, or `hook_event_name`/`session_id` missing or
 *     not non-empty strings → 400 (the session is unaffected);
 *   - otherwise accepted — INCLUDING unknown event names (`unmapped`).
 *
 * Total over unknown; never throws on wire data. The caller parses the HTTP
 * body (unparseable JSON is the same 400 class — see the testkit hook
 * corpus replay).
 */
export function validateHookPost(accountSegment: string, body: unknown): HookPostOutcome {
  if (!isAccountLabel(accountSegment)) {
    return { ok: false, reason: 'unknown-label', httpStatus: 404 };
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      reason: 'malformed-body',
      httpStatus: 400,
      message: 'hook POST body must be a JSON object',
    };
  }
  const hookEventName = body['hook_event_name'];
  if (!isNonEmptyString(hookEventName)) {
    return {
      ok: false,
      reason: 'malformed-body',
      httpStatus: 400,
      message: 'hook_event_name must be a non-empty string',
    };
  }
  const nativeSessionId = body['session_id'];
  if (!isNonEmptyString(nativeSessionId)) {
    return {
      ok: false,
      reason: 'malformed-body',
      httpStatus: 400,
      message: 'session_id must be a non-empty string',
    };
  }
  return {
    ok: true,
    accepted: {
      accountLabel: accountSegment,
      hookEventName,
      nativeSessionId,
      group: mapHookEventName(hookEventName),
      gatingCapable: isGatingCapableHookEvent(hookEventName),
      body,
    },
  };
}

// ---------------------------------------------------------------------------
// Ack shape (the collector's HTTP answer, hooks-contract.md §2/§4)
// ---------------------------------------------------------------------------

/** CLI-schema permission decisions for gating responses (§4). */
export const HOOK_PERMISSION_DECISIONS = Object.freeze(['allow', 'deny', 'ask'] as const);

export type HookPermissionDecision = (typeof HOOK_PERMISSION_DECISIONS)[number];

/** The `200` gating body, in the CLI's own schema (hooks-contract.md §4). */
export interface HookGatingOutput {
  readonly permissionDecision: HookPermissionDecision;
  /** Identifier-free [X2]. */
  readonly permissionDecisionReason?: string;
}

/**
 * The `200` SessionStart body, in the CLI's own hook-output schema (M4
 * freeze; hooks-contract.md §7.1): `additionalContext` is injected into the
 * starting session's context — the [X4] brief-injection vehicle. The body
 * carries file paths + harness/native session ids + placeholder labels ONLY
 * [X2] (producer duty, the approvals-summary precedent).
 */
export interface HookSessionStartOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'SessionStart';
    /** Non-empty markdown injected into the session (the workstream's latest brief). */
    readonly additionalContext: string;
  };
}

export type HookAck =
  /** Accepted, no opinion — the DEFAULT; native permission flow proceeds. */
  | { readonly status: 204 }
  /**
   * Accepted with a body: a gating output (gating-capable events only) or —
   * M4 — a SessionStart injection ({@link HookSessionStartOutput},
   * SessionStart posts only; {@link ackForSessionStart}).
   */
  | { readonly status: 200; readonly body: HookGatingOutput | HookSessionStartOutput }
  /** Unknown label / malformed body (mirrors {@link HookPostRejection}). */
  | { readonly status: 404 }
  | { readonly status: 400 };

/**
 * The one legal ack for an outcome. A gating output is only legal on an
 * ACCEPTED, GATING-CAPABLE post — anything else answers its plain status
 * (rejections mirror their httpStatus; non-gating accepts answer 204 even
 * when an opinion is passed, so a buggy floor can never gate `SessionEnd`).
 */
export function ackForHookOutcome(outcome: HookPostOutcome, gating?: HookGatingOutput): HookAck {
  if (!outcome.ok) return { status: outcome.httpStatus };
  if (gating !== undefined && outcome.accepted.gatingCapable) {
    return { status: 200, body: gating };
  }
  return { status: 204 };
}

// ---------------------------------------------------------------------------
// PermissionRequest → hook-floor relay contract (ws-protocol.md §10.1)
// ---------------------------------------------------------------------------

/**
 * The slice the broker needs to raise an `approval-request` with source
 * `hook-floor`. The broker maps `nativeSessionId` to a harness session id
 * where the ledger knows one, else relays the native id (the approvals wire
 * sessionId charset admits both); `toolName` feeds the identifier-free
 * summary [X2].
 */
export interface HookFloorRelayInput {
  readonly accountLabel: AccountLabel;
  readonly nativeSessionId: string;
  readonly toolName: string;
  readonly toolUseId?: string;
}

/**
 * Extract the hook-floor relay input from an accepted post, or undefined
 * when the post cannot raise an approval (not gating-capable, or no
 * non-empty `tool_name` in the body).
 */
export function hookFloorRelayInput(accepted: AcceptedHookPost): HookFloorRelayInput | undefined {
  if (!accepted.gatingCapable) return undefined;
  const toolName = accepted.body['tool_name'];
  if (!isNonEmptyString(toolName)) return undefined;
  const toolUseId = accepted.body['tool_use_id'];
  return {
    accountLabel: accepted.accountLabel,
    nativeSessionId: accepted.nativeSessionId,
    toolName,
    ...(isNonEmptyString(toolUseId) ? { toolUseId } : {}),
  };
}

// ---------------------------------------------------------------------------
// [X4] automation routing (M4 freeze — hooks-contract.md §7.1)
// ---------------------------------------------------------------------------

/**
 * The three hook events BE-5's accepting endpoint routes to the [X4]
 * workstream automation handlers (blueprint §5 handoff automation;
 * hooks-contract.md §3 [X4] rows):
 *   SessionEnd   → auto continuation brief
 *   PreCompact   → full-fidelity snapshot + `compact` edge
 *   SessionStart → brief injection (the response MAY carry
 *                  {@link HookSessionStartOutput})
 */
export const X4_AUTOMATION_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'PreCompact',
] as const);

export type X4AutomationHookEvent = (typeof X4_AUTOMATION_HOOK_EVENTS)[number];

/**
 * The routing decision for one ACCEPTED post: which [X4] handler slot it
 * reaches, or undefined (not an automation event — events-store-only). Total
 * and deterministic; the collector calls this AFTER validateHookPost.
 */
export function x4AutomationRouteFor(
  accepted: AcceptedHookPost,
): X4AutomationHookEvent | undefined {
  return (X4_AUTOMATION_HOOK_EVENTS as readonly string[]).includes(accepted.hookEventName)
    ? (accepted.hookEventName as X4AutomationHookEvent)
    : undefined;
}

/**
 * The handler port BE-7 registers with BE-5's accepting endpoint (frozen at
 * M4). Routing contract (hooks-contract.md §7.1):
 *
 *   - `onSessionEnd` / `onPreCompact` are POST-ACK fire-and-forget: the
 *     collector answers 204 first and invokes the handler after — a slow or
 *     throwing handler can never stall or fail a session (the <50 ms ack
 *     posture is unchanged). Throws are logged and swallowed collector-side.
 *   - `onSessionStart` is the ONE handler whose output rides the response:
 *     the collector races it against the hook-timeout window (configuration,
 *     like the §4 floor timeout) and answers
 *     `200 + HookSessionStartOutput` when a value arrives in time, else 204.
 *     Returning undefined = no injection (204). The handler decides
 *     startup/resume/clear/compact policy from the body's `source` field —
 *     the body passes through VERBATIM (§2).
 *   - Handlers receive every accepted [X4]-event post for every account —
 *     including EXTERNAL sessions (the account-wide template rule, §3).
 *
 * All handlers are optional: an unregistered slot means the event is
 * events-store-only (the M3 behavior, which stays the default).
 */
export interface WorkstreamHookRouting {
  onSessionEnd?(post: AcceptedHookPost): void;
  onPreCompact?(post: AcceptedHookPost): void;
  onSessionStart?(
    post: AcceptedHookPost,
  ): HookSessionStartOutput | undefined | Promise<HookSessionStartOutput | undefined>;
}

/**
 * The one legal ack for a SessionStart routing outcome — the
 * {@link ackForHookOutcome} discipline applied to injections: an injection
 * body is only ever attached to an ACCEPTED post whose event IS
 * `SessionStart` (a buggy handler can never inject into a tool event), and
 * an empty `additionalContext` degrades to 204 (never an empty injection).
 */
export function ackForSessionStart(
  outcome: HookPostOutcome,
  injection?: HookSessionStartOutput,
): HookAck {
  if (!outcome.ok) return { status: outcome.httpStatus };
  if (
    injection !== undefined &&
    outcome.accepted.hookEventName === 'SessionStart' &&
    injection.hookSpecificOutput.additionalContext.length > 0
  ) {
    return { status: 200, body: injection };
  }
  return { status: 204 };
}
