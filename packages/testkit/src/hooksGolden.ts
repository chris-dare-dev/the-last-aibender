/**
 * Golden hook-POST fixture corpus (hooks-contract.md §6; plan §9.3 BE↔SI #3)
 * — the same corpus-and-replay device the WS protocol uses (ICR-0003
 * precedent), landed with the M3 freeze of the acceptance-side types
 * (@aibender/protocol hooks.ts).
 *
 * Each fixture pins the EXACT POST body bytes + the account-label path
 * segment, and the acceptance verdict the collector must produce: accepted
 * (with vocabulary group, gating capability, and — when applicable — the
 * PermissionRequest→hook-floor relay slice) or the exact rejection status.
 * BE-5's collector replays these against its real HTTP handler; SI-3's
 * templates are validated against the same shapes.
 *
 * [X2]: all fixture content is synthesized — placeholder labels,
 * `synth-native-*` session ids, `/synthetic/...` paths. The suite screens
 * every body through the jsonl.ts identity-shape guard.
 *
 * VERSIONING: {@link GOLDEN_HOOK_CORPUS_FREEZE} must equal the protocol
 * package's PROTOCOL_FREEZE (asserted in the suite).
 */

import {
  PROTOCOL_FREEZE,
  hookFloorRelayInput,
  validateHookPost,
  x4AutomationRouteFor,
  type HookEventGroup,
  type HookFloorRelayInput,
  type X4AutomationHookEvent,
} from '@aibender/protocol';

/** The protocol freeze this corpus pins (asserted equal to PROTOCOL_FREEZE). */
export const GOLDEN_HOOK_CORPUS_FREEZE: typeof PROTOCOL_FREEZE = 'FROZEN-M8';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export type GoldenHookExpectation =
  | {
      readonly accepted: true;
      readonly group: HookEventGroup | 'unmapped';
      readonly gatingCapable: boolean;
      /** The hook-floor relay slice, when the post can raise an approval. */
      readonly relay?: HookFloorRelayInput;
      /**
       * The [X4] automation handler slot this post routes to (M4 freeze,
       * hooks-contract.md §7.1) — SessionStart / SessionEnd / PreCompact;
       * absent = events-store-only.
       */
      readonly x4Route?: X4AutomationHookEvent;
    }
  | {
      readonly accepted: false;
      readonly httpStatus: 400 | 404;
    };

export interface GoldenHookFixture {
  readonly name: string;
  /** The `<ACCOUNT_LABEL>` path segment as received (may be bogus). */
  readonly accountSegment: string;
  /** EXACT POST body bytes — replay verbatim, never re-serialize. */
  readonly bodyJson: string;
  readonly expect: GoldenHookExpectation;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export const GOLDEN_HOOK_FIXTURES: readonly GoldenHookFixture[] = Object.freeze([
  {
    name: 'hook-pretooluse-gating',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'synth-native-1',
      transcript_path: '/synthetic/projects/synth/synth-native-1.jsonl',
      cwd: '/synthetic/workspace',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: '/synthetic/file.ts' },
      tool_use_id: 'toolu_synth_1',
    }),
    expect: {
      accepted: true,
      group: 'tool-lifecycle',
      gatingCapable: true,
      relay: {
        accountLabel: 'MAX_A',
        nativeSessionId: 'synth-native-1',
        toolName: 'Read',
        toolUseId: 'toolu_synth_1',
      },
    },
  },
  {
    name: 'hook-permissionrequest-relay',
    accountSegment: 'MAX_B',
    bodyJson: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'synth-native-2',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }),
    expect: {
      accepted: true,
      group: 'permission-floor',
      gatingCapable: true,
      relay: {
        accountLabel: 'MAX_B',
        nativeSessionId: 'synth-native-2',
        toolName: 'Bash',
      },
    },
    notes: 'no tool_use_id — the relay slice omits it (optional on the approvals wire too)',
  },
  {
    name: 'hook-permissionrequest-no-tool-name',
    accountSegment: 'ENT',
    bodyJson: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'synth-native-3',
    }),
    expect: { accepted: true, group: 'permission-floor', gatingCapable: true },
    notes: 'gating-capable but no tool_name → accepted, NO relay (nothing to summarize [X2])',
  },
  {
    name: 'hook-posttooluse-not-gating',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'synth-native-1',
      tool_name: 'Write',
      tool_input: { file_path: '/synthetic/out.ts' },
      tool_output: { ok: true },
      tool_use_id: 'toolu_synth_2',
    }),
    expect: { accepted: true, group: 'tool-lifecycle', gatingCapable: false },
    notes: 'PostToolUse feeds the events store + context graph — never the gating path',
  },
  {
    name: 'hook-sessionstart-lifecycle',
    accountSegment: 'AWS_DEV',
    bodyJson: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'synth-native-4',
      source: 'startup',
    }),
    expect: {
      accepted: true,
      group: 'session-lifecycle',
      gatingCapable: false,
      x4Route: 'SessionStart',
    },
    notes:
      'M4 routing pin: SessionStart reaches the brief-injection handler (the response MAY carry ' +
      'HookSessionStartOutput — ackForSessionStart); the startup/resume/clear/compact policy is ' +
      "handler-side, decided from the body's source field",
  },
  {
    name: 'hook-sessionstart-resume-injection',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'synth-native-1',
      source: 'resume',
    }),
    expect: {
      accepted: true,
      group: 'session-lifecycle',
      gatingCapable: false,
      x4Route: 'SessionStart',
    },
    notes: 'the blueprint §5 injection case: SessionStart(resume) → inject the latest brief',
  },
  {
    name: 'hook-sessionend-auto-brief',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 'synth-native-1',
      reason: 'exit',
    }),
    expect: {
      accepted: true,
      group: 'session-lifecycle',
      gatingCapable: false,
      x4Route: 'SessionEnd',
    },
    notes:
      'M4 routing pin: SessionEnd reaches the auto-brief handler POST-ACK (204 first, handler ' +
      'after — a slow handler can never stall a session)',
  },
  {
    name: 'hook-filechanged-context',
    accountSegment: 'LOCAL',
    bodyJson: JSON.stringify({
      hook_event_name: 'FileChanged',
      session_id: 'synth-native-5',
      file_path: '/synthetic/watched.md',
    }),
    expect: { accepted: true, group: 'context-files', gatingCapable: false },
  },
  {
    name: 'hook-precompact-compaction',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'PreCompact',
      session_id: 'synth-native-1',
      trigger: 'auto',
    }),
    expect: {
      accepted: true,
      group: 'compaction',
      gatingCapable: false,
      x4Route: 'PreCompact',
    },
    notes:
      'M4 routing pin: PreCompact reaches the snapshot + compact-edge handler POST-ACK',
  },
  {
    name: 'hook-unknown-event-unmapped',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({
      hook_event_name: 'FutureEventFromMinorBump',
      session_id: 'synth-native-1',
      novel_field: 'passes through untouched',
    }),
    expect: { accepted: true, group: 'unmapped', gatingCapable: false },
    notes:
      'THE vocabulary-bump rule (hooks-contract.md §2): unknown event names are ACCEPTED as ' +
      'unmapped — ingestion never breaks on a CLI minor',
  },
  {
    name: 'hook-unknown-label-404',
    accountSegment: 'PERSONAL',
    bodyJson: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'synth-native-1',
      tool_name: 'Read',
    }),
    expect: { accepted: false, httpStatus: 404 },
    notes: 'label attribution comes from the path ONLY — an unknown segment is never guessed [X2]',
  },
  {
    name: 'hook-max-c-open-form-accepted',
    accountSegment: 'MAX_C',
    bodyJson: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'synth-native-1',
      tool_name: 'Write',
      tool_output: { ok: true },
    }),
    expect: { accepted: true, group: 'tool-lifecycle', gatingCapable: false },
    notes:
      'ICR-0013: a hook POST on a newly provisioned Max account (MAX_C) is ACCEPTED — the ' +
      'path segment is a sanctioned label by FORM (^MAX_[A-Z]$), no code change needed',
  },
  {
    name: 'hook-lowercase-label-404',
    accountSegment: 'max_a',
    bodyJson: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'synth-native-1',
    }),
    expect: { accepted: false, httpStatus: 404 },
    notes: 'labels are exact-match — no case folding, no normalization',
  },
  {
    name: 'hook-missing-session-id-400',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({ hook_event_name: 'Stop' }),
    expect: { accepted: false, httpStatus: 400 },
  },
  {
    name: 'hook-missing-event-name-400',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify({ session_id: 'synth-native-1' }),
    expect: { accepted: false, httpStatus: 400 },
  },
  {
    name: 'hook-body-not-object-400',
    accountSegment: 'MAX_A',
    bodyJson: JSON.stringify(['hook_event_name', 'PreToolUse']),
    expect: { accepted: false, httpStatus: 400 },
  },
  {
    name: 'hook-body-not-json-400',
    accountSegment: 'MAX_A',
    bodyJson: 'hook_event_name=PreToolUse',
    expect: { accepted: false, httpStatus: 400 },
    notes: 'unparseable body = the same 400 class; the session is unaffected (fire-and-forget)',
  },
] satisfies readonly GoldenHookFixture[]);

// ---------------------------------------------------------------------------
// Reference replay
// ---------------------------------------------------------------------------

export interface GoldenHookReplayResult {
  readonly accepted: boolean;
  readonly httpStatus?: 400 | 404;
  readonly group?: HookEventGroup | 'unmapped';
  readonly gatingCapable?: boolean;
  readonly relay?: HookFloorRelayInput;
  /** The [X4] automation slot the accepted post routes to (M4 freeze). */
  readonly x4Route?: X4AutomationHookEvent;
}

/**
 * Route one fixture the way BE-5's collector routes a POST: parse the body
 * (unparseable → 400), then validateHookPost(pathLabel, body), then — for
 * accepted posts — extract the hook-floor relay slice and the [X4]
 * automation route (M4, hooks-contract.md §7.1). Departments may replay the
 * raw bytes through their real HTTP handler instead; the bytes and verdicts
 * are the contract, this helper is the convenience.
 */
export function replayGoldenHookFixture(fixture: GoldenHookFixture): GoldenHookReplayResult {
  let body: unknown;
  try {
    body = JSON.parse(fixture.bodyJson);
  } catch {
    return { accepted: false, httpStatus: 400 };
  }
  const outcome = validateHookPost(fixture.accountSegment, body);
  if (!outcome.ok) return { accepted: false, httpStatus: outcome.httpStatus };
  const relay = hookFloorRelayInput(outcome.accepted);
  const x4Route = x4AutomationRouteFor(outcome.accepted);
  return {
    accepted: true,
    group: outcome.accepted.group,
    gatingCapable: outcome.accepted.gatingCapable,
    ...(relay !== undefined ? { relay } : {}),
    ...(x4Route !== undefined ? { x4Route } : {}),
  };
}
