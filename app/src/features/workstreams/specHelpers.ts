/**
 * Spec-only builders for the workstream suites (imported by *.spec files
 * exclusively — never by shipped modules). All values are synthesized; the
 * identity-shaped strings are runtime-built so no scanner-shaped literal is
 * committed to this public repo (testkit convention) [X2].
 */

import type {
  BranchAdvisory,
  WorkstreamBriefPayload,
  WorkstreamDetailSnapshot,
  WorkstreamEdgeEvent,
  WorkstreamListSnapshot,
  WorkstreamNodeEvent,
  WorkstreamNodeRecord,
  WorkstreamSummary,
} from '@aibender/protocol';

export const T0 = 90_100_000;

/** A node UPSERT event (kind carried — the wire shape). */
export function nodeEvent(
  sessionId: string,
  overrides: Partial<Omit<WorkstreamNodeEvent, 'kind' | 'sessionId'>> = {},
): WorkstreamNodeEvent {
  return {
    kind: 'workstream-node',
    sessionId,
    backend: 'claude_code',
    account: 'MAX_A',
    state: 'idle',
    origin: 'harness',
    confidence: 'recorded',
    createdAt: T0,
    ...overrides,
  };
}

/** The store/record shape (no kind) — for snapshot bodies + layout inputs. */
export function nodeRecord(
  sessionId: string,
  overrides: Partial<Omit<WorkstreamNodeRecord, 'sessionId'>> = {},
): WorkstreamNodeRecord {
  const { kind: _kind, ...record } = nodeEvent(sessionId, overrides);
  return record;
}

/** An edge APPEND event. Pass `fromSessionId: undefined` for import edges. */
export function edgeEvent(
  edgeId: string,
  fromSessionId: string | undefined,
  toSessionId: string,
  overrides: Partial<Omit<WorkstreamEdgeEvent, 'kind' | 'edgeId' | 'toSessionId'>> = {},
): WorkstreamEdgeEvent {
  return {
    kind: 'workstream-edge',
    edgeId,
    ...(fromSessionId !== undefined ? { fromSessionId } : {}),
    toSessionId,
    edgeType: 'continue',
    confidence: 'recorded',
    ts: T0,
    ...overrides,
  };
}

export function summary(
  workstreamId: string,
  overrides: Partial<Omit<WorkstreamSummary, 'workstreamId'>> = {},
): WorkstreamSummary {
  return {
    workstreamId,
    title: `stream ${workstreamId}`,
    status: 'active',
    nodeCount: 1,
    updatedAt: T0,
    ...overrides,
  };
}

export function listSnap(
  workstreams: readonly WorkstreamSummary[],
  detachedNodeCount = 0,
  capturedAt = T0,
): WorkstreamListSnapshot {
  return { kind: 'workstream-list-snapshot', capturedAt, workstreams, detachedNodeCount };
}

/** Detail snapshot for ONE workstream scope (summary REQUIRED — §16.1 matrix). */
export function detailSnap(
  ws: WorkstreamSummary,
  nodes: readonly WorkstreamNodeRecord[],
  edges: WorkstreamDetailSnapshot['edges'] = [],
  capturedAt = T0,
): WorkstreamDetailSnapshot {
  return { kind: 'workstream-detail-snapshot', capturedAt, scope: 'workstream', workstream: ws, nodes, edges };
}

/** Detail snapshot for the detached-HEAD bucket (summary FORBIDDEN). */
export function detachedSnap(
  nodes: readonly WorkstreamNodeRecord[],
  edges: WorkstreamDetailSnapshot['edges'] = [],
  capturedAt = T0,
): WorkstreamDetailSnapshot {
  return { kind: 'workstream-detail-snapshot', capturedAt, scope: 'detached', nodes, edges };
}

export function brief(
  briefId: string,
  sourceSessionIds: readonly string[],
  overrides: Partial<Omit<WorkstreamBriefPayload, 'kind' | 'briefId' | 'sourceSessionIds'>> = {},
): WorkstreamBriefPayload {
  return {
    kind: 'workstream-brief',
    briefId,
    briefKind: 'session-end',
    body: `continuation brief for ${sourceSessionIds.join(', ')}`,
    sourceSessionIds,
    provenance: 'native-summary',
    createdAt: T0,
    ...overrides,
  };
}

export function advisory(sessionId: string, contextUsedPct = 71.5, ts = T0): BranchAdvisory {
  return { kind: 'branch-advisory', sessionId, contextUsedPct, ts };
}

/** Identity-shaped adversarial strings (runtime-built — never literals). */
export function adversarialStrings(): { emailish: string; awsIdish: string; tokenish: string } {
  return {
    emailish: ['owner.real', 'example.com'].join('@'),
    awsIdish: '987654'.repeat(2),
    tokenish: ['sk', 'live0token0live0'].join('-'),
  };
}
