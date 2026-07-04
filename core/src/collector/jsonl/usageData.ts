/**
 * usage-data/{facets,session-meta} normalization (BE-5 source 1; blueprint
 * §6.1 "Claude transcripts + insights"; observability findings §2).
 *
 * Mapping decisions (normalizer-side; no schema change):
 *   - `usage-data/facets/<session-uuid>.json` (Haiku-labeled per-session
 *     assessments: `outcome`, `friction_detail`, …) → ONE `session_outcomes`
 *     row: `outcome` from the file's open vocabulary (`unknown` when absent),
 *     `friction` from `friction_detail`, `facets_json` the file VERBATIM
 *     after the [X2] identity scrub (identity dropped at ingest — the DDL
 *     comment's exact promise, sqlite-ddl.md §7.4).
 *   - `usage-data/session-meta/<session-uuid>.json` (deterministic stats:
 *     `input_tokens`/`output_tokens`, tool counts, …) → ONE `events` row
 *     (`event_type: 'session_meta'`) because it carries token totals the
 *     events fact table is built for; the scrubbed stats JSON is preserved
 *     on a companion `session_outcomes` row only when it has an outcome —
 *     which session-meta does not, so it lands in events alone.
 *
 * Dedupe: raw_ref carries the session uuid (`facets:<uuid>` /
 * `session-meta:<uuid>`) — a re-scan of an unchanged file is a no-op; a
 * REWRITTEN facets file (insights re-run) keeps the same raw_ref so the
 * FIRST capture wins (revision tracking is a read-model concern, not a
 * fact-table one).
 */

import type { AccountLabel } from '@aibender/protocol';
import type { NewEventRow, NewSessionOutcomeRow } from '@aibender/schema';

import { scrubIdentityDeep, scrubIdentityText } from '../identity.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export interface NormalizeUsageDataInput {
  /** From the watch root ONLY [X2]. */
  readonly account: AccountLabel;
  /** The `<session-uuid>` from the FILE NAME (native session id). */
  readonly sessionUuid: string;
  /** Raw file contents. */
  readonly json: string;
  /** Capture instant (file mtime, epoch ms). */
  readonly capturedAtMs: number;
}

/** facets/<uuid>.json → session_outcomes row (undefined = unparseable). */
export function normalizeFacetsFile(
  input: NormalizeUsageDataInput,
): NewSessionOutcomeRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const outcomeRaw = record['outcome'];
  const outcome =
    typeof outcomeRaw === 'string' && outcomeRaw.trim().length > 0
      ? scrubIdentityText(outcomeRaw)
      : 'unknown';
  const frictionRaw = record['friction_detail'];
  const friction =
    typeof frictionRaw === 'string' && frictionRaw.trim().length > 0
      ? scrubIdentityText(frictionRaw)
      : undefined;
  return {
    account: input.account,
    nativeSessionId: input.sessionUuid,
    outcome,
    ...(friction !== undefined ? { friction } : {}),
    facetsJson: JSON.stringify(scrubIdentityDeep(record)),
    capturedAtMs: input.capturedAtMs,
    rawRef: `facets:${input.sessionUuid}`,
  };
}

/** session-meta/<uuid>.json → events row (undefined = unparseable). */
export function normalizeSessionMetaFile(input: NormalizeUsageDataInput): NewEventRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const inputTokens = asCount(record['input_tokens']);
  const outputTokens = asCount(record['output_tokens']);
  return {
    tsMs: input.capturedAtMs,
    backend: 'claude_code',
    account: input.account,
    source: 'claude-jsonl',
    eventType: 'session_meta',
    nativeSessionId: input.sessionUuid,
    rawRef: `session-meta:${input.sessionUuid}`,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}
