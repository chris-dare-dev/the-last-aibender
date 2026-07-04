/**
 * history.jsonl normalization (BE-5 source 1; observability findings §2:
 * "every prompt with `display`, `timestamp`, `project`, `sessionId` — cheap
 * global prompt-frequency index").
 *
 * One history line → one `user_prompt` events row. VALUE-LIGHT by design
 * [X2]: the `display` text is NEVER stored (free text is where identities
 * live, and the events table deliberately has no prompt-text column); the
 * row carries only time + session attribution.
 *
 * raw_ref is content-derived (`history:<fnv32(line)>`): history.jsonl is
 * append-only but line NUMBERS shift under truncation/rotation, so the
 * dedupe key must not depend on position. Identical re-read lines land on
 * the same key — a re-tail is a no-op.
 */

import type { AccountLabel } from '@aibender/protocol';
import type { NewEventRow } from '@aibender/schema';

import { fnv32Hex } from '../hash.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accepts epoch seconds, epoch ms, or ISO-8601 (the CLI has shipped all). */
function parseHistoryTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    // Heuristic: values below 1e12 are epoch SECONDS (1e12 ms ≈ 2001-09).
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export interface NormalizeHistoryLineInput {
  /** From the watch root ONLY [X2]. */
  readonly account: AccountLabel;
  readonly line: string;
}

export type HistoryLineOutcome =
  | { readonly kind: 'malformed' }
  | { readonly kind: 'row'; readonly row: NewEventRow };

export function normalizeHistoryLine(input: NormalizeHistoryLineInput): HistoryLineOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.line);
  } catch {
    return { kind: 'malformed' };
  }
  const record = asRecord(parsed);
  if (record === undefined) return { kind: 'malformed' };
  const tsMs = parseHistoryTimestamp(record['timestamp']);
  if (tsMs === undefined) return { kind: 'malformed' };
  const sessionId = record['sessionId'];
  return {
    kind: 'row',
    row: {
      tsMs,
      backend: 'claude_code',
      account: input.account,
      source: 'claude-jsonl',
      eventType: 'user_prompt',
      rawRef: `history:${fnv32Hex(input.line)}`,
      ...(typeof sessionId === 'string' && sessionId.length > 0
        ? { nativeSessionId: sessionId }
        : {}),
    },
  };
}
