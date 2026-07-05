/**
 * Store-row → wire-record projections for the `workstream` channel (BE-7;
 * ws-protocol.md §16, plan §4/BE-7 item 8).
 *
 * [X2] BY CONSTRUCTION: `native_session_id` and `native_scope` are
 * deliberately never read here — there is NO code path from a store row's
 * native id to a wire record (the §16 identity rule: native ids are STORE
 * attributes; harness ids only on the wire). `transcript_ref` / `worktree` /
 * `first_prompt_hash` stay store-side too: the frozen node record does not
 * carry them.
 *
 * Optionals map null → ABSENT (the frozen validators refuse null members).
 */

import type {
  WorkstreamEdgeRecord,
  WorkstreamNodeRecord,
  WorkstreamServerPayload,
  WorkstreamSummary,
} from '@aibender/protocol';
import type { SessionEdgeRow, SessionNodeRow, WorkstreamRow } from '@aibender/schema';

/**
 * The one fan-out sink BE-7 publishes through — structurally the gateway
 * handle's `publishWorkstream` (composeBroker binds it; tests capture
 * arrays). Implementations THROW on invalid payloads (the gateway's
 * RangeError discipline); callers in never-throw contexts wrap accordingly.
 */
export type WorkstreamPublisher = (payload: WorkstreamServerPayload) => void;

/** Project one workstream row into its rail summary. */
export function summaryOfWorkstream(row: WorkstreamRow, nodeCount: number): WorkstreamSummary {
  return {
    workstreamId: row.id,
    title: row.title,
    status: row.status,
    ...(row.tags.length > 0 ? { tags: row.tags } : {}),
    nodeCount,
    updatedAt: row.updatedAtMs,
  };
}

/** Project one session-node row into its wire record (harness ids only [X2]). */
export function nodeToWire(row: SessionNodeRow): WorkstreamNodeRecord {
  return {
    sessionId: row.id,
    ...(row.workstreamId !== null ? { workstreamId: row.workstreamId } : {}),
    backend: row.backend,
    account: row.account,
    state: row.state,
    origin: row.origin,
    confidence: row.confidence,
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.gitBranch !== null ? { gitBranch: row.gitBranch } : {}),
    ...(row.tokensIn !== null ? { tokensIn: row.tokensIn } : {}),
    ...(row.tokensOut !== null ? { tokensOut: row.tokensOut } : {}),
    ...(row.costEstimatedUsd !== null ? { costEstimatedUsd: row.costEstimatedUsd } : {}),
    createdAt: row.createdAtMs,
    ...(row.lastActiveAtMs !== null ? { lastActiveAt: row.lastActiveAtMs } : {}),
  };
}

/** Project one session-edge row into its wire record. */
export function edgeToWire(row: SessionEdgeRow): WorkstreamEdgeRecord {
  return {
    edgeId: row.id,
    ...(row.fromNode !== null ? { fromSessionId: row.fromNode } : {}),
    toSessionId: row.toNode,
    edgeType: row.edgeType,
    ...(row.briefId !== null ? { briefId: row.briefId } : {}),
    confidence: row.confidence,
    ts: row.createdAtMs,
  };
}
