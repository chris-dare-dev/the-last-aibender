/**
 * Accepted hook POST → events row (BE-5 source 8; hooks-contract.md §2/§3;
 * FROZEN acceptance types in @aibender/protocol hooks.ts).
 *
 * event_type = the native `hook_event_name` VERBATIM (open vocabulary —
 * unknown names were already accepted as `unmapped` by validateHookPost and
 * still land, hooks-contract.md §2). Attribution comes ONLY from the URL
 * path label the validator extracted [X2]; backend follows the frozen
 * label↔backend pairing (hooks fire for every session in a config dir).
 *
 * raw_ref: hook POSTs are fire-and-forget one-shots with no native id — a
 * per-process monotonic receipt counter keys them (`hook:<n>:<ms>`); nothing
 * is ever re-read from disk for this source, so process-scoped uniqueness is
 * the correct dedupe posture (mirrors the LM Studio capture).
 */

import type { AcceptedHookPost } from '@aibender/protocol';
import { backendForLabel } from '@aibender/protocol';
import type { NewEventRow } from '@aibender/schema';

import { scrubIdentityText } from '../identity.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface NormalizeHookPostInput {
  readonly accepted: AcceptedHookPost;
  readonly tsMs: number;
  /** Per-process receipt counter (the server supplies it). */
  readonly receipt: number;
}

export function normalizeAcceptedHookPost(input: NormalizeHookPostInput): NewEventRow {
  const { accepted, tsMs, receipt } = input;
  const body = accepted.body;
  const toolName = asString(body['tool_name']);
  const toolInput = asRecord(body['tool_input']);

  const fileRefs: string[] = [];
  for (const candidate of [body['file_path'], toolInput?.['file_path'], toolInput?.['path']]) {
    if (typeof candidate === 'string' && candidate.startsWith('/')) fileRefs.push(candidate);
  }

  const isFailure =
    accepted.hookEventName === 'PostToolUseFailure' || accepted.hookEventName === 'StopFailure';

  return {
    tsMs,
    backend: backendForLabel(accepted.accountLabel),
    account: accepted.accountLabel,
    source: 'hooks',
    eventType: scrubIdentityText(accepted.hookEventName),
    nativeSessionId: accepted.nativeSessionId,
    rawRef: `hook:${String(receipt)}:${String(tsMs)}`,
    ...(toolName !== undefined ? { toolName: scrubIdentityText(toolName) } : {}),
    ...(fileRefs.length > 0 ? { fileRefs } : {}),
    ...(isFailure ? { ok: false, errorKind: 'error' as const } : {}),
  };
}
