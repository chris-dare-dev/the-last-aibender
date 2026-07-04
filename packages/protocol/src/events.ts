/**
 * `events` channel payloads — the collector fan-out (blueprint §6.1/§6.2;
 * plan §4/BE-5, BE-6). This is the payload union the M2 full freeze
 * explicitly DEFERRED to M3 (ws-protocol.md §8) — it freezes here, with
 * BE-5's normalized events store (@aibender/schema migration 0002).
 *
 * Broker → client only; the only client→broker payload the events channel
 * accepts is the generic `replay-request` (replay.ts) — unchanged from M2.
 *
 * Two frozen kinds ride the channel:
 *   - `event-summary`       one normalized events-store row, value-light
 *                           (events.ts, this file);
 *   - `read-model-snapshot` one §6.3 dashboard read model with explicit
 *                           per-source freshness (readModels.ts).
 *
 * FORWARD-TOLERANT READER (frozen rule, M3): an events payload whose `kind`
 * is a non-empty string OUTSIDE the frozen set is LEGAL and MUST be ignored
 * by clients (decoded as {@link OpaqueEventsPayload}). M4/M5 add dashboard
 * kinds (workstream lenses, pipeline run monitors) without breaking M3
 * clients — this codifies the M2 "opaque envelope" policy as the permanent
 * compatibility rule. Registered kinds still validate STRICTLY.
 *
 * [X2] — summaries are deliberately value-light: NO raw_ref, NO file_refs,
 * NO native ids, NO prompt/tool bodies. Account is the placeholder label
 * enum; identity attributes were already dropped at ingest (blueprint §6.2).
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { TranscriptUsage } from './transcript.js';
import type { AccountLabel, Backend } from './vocab.js';

/**
 * The observability feeds of the blueprint §6.1 collection matrix. Frozen as
 * the `events.source` DDL vocabulary AND the freshness-state axis dashboards
 * key on (readModels.ts).
 */
export const EVENT_SOURCES = Object.freeze([
  /** Per-account `projects/**` JSONL fs-watch tailer (ground-truth tokens). */
  'claude-jsonl',
  /** In-process OTLP receiver on 127.0.0.1:4318 (attribution truth). */
  'claude-otel',
  /** Statusline tee file + idle-account OAuth usage poll (quota feed). */
  'claude-quota',
  /** The /hooks/v1/<LABEL> collector (hooks-contract.md). */
  'hooks',
  /** OpenCode `/global/event` SSE (evt_ dedupe, after=<seq> replay). */
  'opencode-sse',
  /** Read-only opencode.db scrape (account/credential tables guarded [X2]). */
  'opencode-db',
  /** Cost Explorer poll, 1–2×/day — authoritative USD, ~24 h lag. */
  'bedrock-cost-explorer',
  /** CloudWatch AWS/Bedrock poll, 5–15 min while active. */
  'bedrock-cloudwatch',
  /** LM Studio inline usage + perf capture per harness-routed call. */
  'lmstudio',
  /** Optional admin-key-gated ENT org analytics adapter. */
  'ent-analytics',
] as const);

export type EventSource = (typeof EVENT_SOURCES)[number];

export function isEventSource(value: unknown): value is EventSource {
  return typeof value === 'string' && (EVENT_SOURCES as readonly string[]).includes(value);
}

/**
 * Per-source freshness states (blueprint §6.3, plan BE-6): degraded sources
 * are STATES rendered as NO SIGNAL — never errors, never fabricated zeros.
 */
export const SOURCE_FRESHNESS_STATES = Object.freeze([
  /** Signal within the source's freshness window. */
  'fresh',
  /** Signal exists but is older than the window. */
  'stale',
  /** Nothing ever ingested from this source (render NO SIGNAL). */
  'no-signal',
  /** LM Studio is down — first-class state, not an error (blueprint §4.3). */
  'lmstudio-down',
  /** Colima/k3s cluster absent — proves the non-dependency ([X3]). */
  'cluster-absent',
  /** AWS SSO session expired — pollers gated until the owner re-auths. */
  'sso-expired',
  /** Account has no live login — keychain/auth absent for the label. */
  'account-logged-out',
  /** Actuals gated (e.g. SI-4 unapplied) — estimates render, labeled honestly. */
  'estimate-only',
] as const);

export type SourceFreshnessState = (typeof SOURCE_FRESHNESS_STATES)[number];

export function isSourceFreshnessState(value: unknown): value is SourceFreshnessState {
  return (
    typeof value === 'string' && (SOURCE_FRESHNESS_STATES as readonly string[]).includes(value)
  );
}

/** One source's freshness as carried on every read-model snapshot. */
export interface SourceFreshness {
  readonly source: EventSource;
  readonly state: SourceFreshnessState;
  /** Epoch ms of the last ingested signal; absent when none ever arrived. */
  readonly lastIngestAt?: number;
}

/**
 * Error classification for the §6.3 error/retry/throttle health lead.
 * Matches the `events.error_kind` DDL vocabulary.
 */
export const EVENT_ERROR_KINDS = Object.freeze(['error', 'retry', 'throttle', 'timeout'] as const);

export type EventErrorKind = (typeof EVENT_ERROR_KINDS)[number];

export function isEventErrorKind(value: unknown): value is EventErrorKind {
  return typeof value === 'string' && (EVENT_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * One normalized events-store row as it fans out to dashboards. Mirrors the
 * `events` fact table (sqlite-ddl.md, migration 0002) minus everything
 * value-heavy or machine-locating: raw_ref and file_refs stay in the store.
 */
export interface EventSummary {
  readonly kind: 'event-summary';
  /** Events-store row id — the dashboard-side dedupe/ordering axis. */
  readonly eventId: number;
  /** Event time, epoch ms. */
  readonly ts: number;
  /** Placeholder label only [X2]. */
  readonly account: AccountLabel;
  /** Must satisfy the frozen label↔backend pairing (vocab.ts). */
  readonly backend: Backend;
  readonly source: EventSource;
  /**
   * Normalized event type. OPEN vocabulary (the CLI adds hook events in
   * minor bumps; ingestion never breaks on a vocabulary bump) — non-empty.
   */
  readonly eventType: string;
  /** Harness session id when the event maps to one (never a native id). */
  readonly sessionId?: string;
  readonly model?: string;
  /** The four ground-truth token classes (blueprint §6.2). */
  readonly usage?: TranscriptUsage;
  /** Client-side estimate (prices table) — always labeled an estimate. */
  readonly costEstimatedUsd?: number;
  /** Cost Explorer backfill, when it landed for this row's backend/day. */
  readonly costActualUsd?: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
  readonly toolName?: string;
  readonly skillName?: string;
  readonly ok?: boolean;
  readonly errorKind?: EventErrorKind;
}

/**
 * Decoded form of an events payload whose `kind` is outside the frozen set:
 * legal by the forward-tolerant reader rule; clients MUST ignore it. The
 * `opaque` marker is a DECODE-side discriminant only — it never rides the
 * wire (validators sanitize unknown payloads down to their kind).
 */
export interface OpaqueEventsPayload {
  readonly kind: string;
  readonly opaque: true;
}
