/**
 * AcceptedHookPost → ContextGraphTouch[] projection (BE-6; ws-protocol.md
 * §12, hooks-contract.md §3). Consumes the FROZEN-M3 hooks acceptance type
 * (@aibender/protocol hooks.ts) — the watcher event surface the hook
 * collector (BE-5) exposes after validateHookPost.
 *
 * [X2] BY CONSTRUCTION: the produced touches carry file paths + session ids
 * ONLY. `accepted.accountLabel` is deliberately never read here — there is no
 * code path from the label to the touch, mirroring the §12 validator that
 * rejects account keys outright.
 *
 * SESSION-ID POLICY: hook bodies carry NATIVE session ids. §12 wants harness
 * session ids, so the caller injects `resolveSessionId` (the ledger mapping,
 * BE-7/M4). The DEFAULT resolver relays the native id verbatim — the same
 * precedent the frozen hooks contract sets for the approvals relay
 * (hooks.ts `hookFloorRelayInput`: "maps nativeSessionId to a harness session
 * id where the ledger knows one, else relays the native id"). Ids that fail
 * the wire charset are dropped by the feed's validator, never rewritten.
 */

import type { AcceptedHookPost, ContextGraphTouch } from '@aibender/protocol';

import { absolutePathsFrom, relationForTool } from './relations.js';

export interface HookTouchOptions {
  /**
   * Native → harness session-id mapping. Returning undefined drops the
   * touch (the session is unknown to the harness and the feed never
   * guesses). Default: relay the native id (see module doc).
   */
  readonly resolveSessionId?: (nativeSessionId: string) => string | undefined;
  /** Touch timestamp source (epoch ms). Default Date.now. */
  readonly clock?: () => number;
}

/**
 * Project one accepted hook POST into its context-graph touches. Events
 * outside the §12 relation table produce NO touches (never a guess):
 *   - PostToolUse on a read/write-shaped tool → one touch per absolute path
 *     in `tool_input`;
 *   - InstructionsLoaded → `instructions` touch on the body's file path;
 *   - FileChanged → `watched` touch on the body's file path;
 *   - everything else → [].
 */
export function touchesFromHookPost(
  accepted: AcceptedHookPost,
  options: HookTouchOptions = {},
): readonly ContextGraphTouch[] {
  const resolve = options.resolveSessionId ?? ((nativeSessionId: string) => nativeSessionId);
  const now = options.clock ?? Date.now;

  const sessionId = resolve(accepted.nativeSessionId);
  if (sessionId === undefined) return [];

  const ts = now();
  const touch = (path: string, relation: ContextGraphTouch['relation']): ContextGraphTouch => ({
    kind: 'context-touch',
    sessionId,
    path,
    relation,
    ts,
  });

  switch (accepted.hookEventName) {
    case 'PostToolUse': {
      const toolName = accepted.body['tool_name'];
      if (typeof toolName !== 'string') return [];
      const relation = relationForTool(toolName);
      if (relation === undefined) return [];
      return absolutePathsFrom(accepted.body['tool_input']).map((path) => touch(path, relation));
    }
    case 'InstructionsLoaded':
      return absolutePathsFrom(accepted.body).map((path) => touch(path, 'instructions'));
    case 'FileChanged':
      return absolutePathsFrom(accepted.body).map((path) => touch(path, 'watched'));
    default:
      return [];
  }
}
