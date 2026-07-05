/**
 * FE-6 workstream lineage store — the client-side read model of the FROZEN
 * `workstream` channel (ws-protocol.md §16): the rail (list snapshot), one
 * global node/edge graph (detail snapshots re-baseline their scope; node
 * events UPSERT on sessionId; edge events APPEND on edgeId — edges are
 * immutable once recorded), the brief shelf, the branch-now advisory
 * instrument state, and merge correlation (`mergeId` → pending / resolved /
 * failed with the frozen §16.4 codes).
 *
 * Discipline (plan §5 FE iron rules — the observability store precedent):
 *   - wire writes land ONLY through {@link WorkstreamsStoreState.applyBatch}
 *     — one store write per rAF frame batch (bind.ts owns the projector);
 *     React render counts are bounded by frames, never by wire messages;
 *   - snapshots are MONOTONE on `capturedAt` per scope: a replayed older
 *     snapshot never regresses the view (§16.5 re-baseline posture);
 *   - the ONE ceremonial animation (DESIGN.md §3.3) is armed here and only
 *     here: a `workstream-edge` EVENT (a ledger-committed lineage edge) sets
 *     the ceremony marker; snapshot-carried edges render settled; when
 *     multiple edge events land in one batch only the NEWEST arms (the §3.3
 *     coalescing rule). Node upserts, briefs, advisories and merge
 *     resolutions NEVER arm ceremony — lineage events only.
 */

import { createStore } from 'zustand/vanilla';
import type {
  BranchAdvisory,
  ErrorCode,
  WorkstreamBriefPayload,
  WorkstreamEdgeRecord,
  WorkstreamListSnapshot,
  WorkstreamNodeRecord,
  WorkstreamServerPayload,
} from '@aibender/protocol';

/** Brief shelf bound — a machine-local convenience cache, never a ledger. */
export const MAX_BRIEFS = 128;

/** Scope key for detail-snapshot monotonicity ('detached' or a workstream id). */
export const DETACHED_SCOPE = 'detached';

/**
 * Merge request lifecycle as the deck instruments it:
 *   blocked    — refused CLIENT-side by the frozen validator (never sent;
 *                the server stays the authority for everything sent);
 *   unsendable — valid but the wire was down / the sender seam is absent;
 *   pending    — sent, awaiting `workstream-merge-resolved` or a pushed error;
 *   resolved   — the broker fanned out the new merge node;
 *   failed     — a pushed §16.4 error correlated by mergeId.
 */
export type MergePhase = 'blocked' | 'unsendable' | 'pending' | 'resolved' | 'failed';

export interface MergeState {
  readonly mergeId: string;
  readonly phase: MergePhase;
  /** Parent selection at dispatch time (render affordance only). */
  readonly parents?: readonly string[];
  /** The NEW merge node's harness session id (resolved). */
  readonly sessionId?: string;
  /** The merge brief seeded into the node (resolved). */
  readonly briefId?: string;
  /** The frozen error code (blocked / failed). */
  readonly code?: ErrorCode;
}

/** The armed ceremony marker — at most one, the newest lineage event. */
export interface CeremonyMarker {
  readonly edgeId: string;
  readonly toSessionId: string;
  /** Monotone retrigger key (the Phosphor epoch pattern). */
  readonly epoch: number;
}

export interface WorkstreamsStoreState {
  /** Latest rail snapshot (workstream summaries + detached-HEAD count). */
  readonly rail: WorkstreamListSnapshot | undefined;
  /** Global node map keyed on harness sessionId (UPSERT semantics). */
  readonly nodes: Readonly<Record<string, WorkstreamNodeRecord>>;
  /** Global edge map keyed on edgeId (APPEND semantics — immutable). */
  readonly edges: Readonly<Record<string, WorkstreamEdgeRecord>>;
  /** Edge insertion order (stable render + layout determinism). */
  readonly edgeOrder: readonly string[];
  /** Brief shelf keyed on briefId, bounded to {@link MAX_BRIEFS}. */
  readonly briefs: Readonly<Record<string, WorkstreamBriefPayload>>;
  /** Brief arrival order, oldest first (eviction axis). */
  readonly briefOrder: readonly string[];
  /** Latest advisory per pressured session (monotone on ts). */
  readonly advisories: Readonly<Record<string, BranchAdvisory>>;
  /** Dismissal watermark per session: advisories at ts <= mark stay hidden. */
  readonly advisoryDismissedAt: Readonly<Record<string, number>>;
  /** Merge correlation table keyed on mergeId. */
  readonly merges: Readonly<Record<string, MergeState>>;
  /** Per-scope detail-snapshot capturedAt watermark (monotone). */
  readonly scopeCapturedAt: Readonly<Record<string, number>>;
  readonly ceremony: CeremonyMarker | undefined;

  /** Apply one frame batch of validated payloads (ONE store write). */
  applyBatch(batch: readonly WorkstreamServerPayload[]): void;
  /** Local dispatch bookkeeping (merge.ts controller). */
  trackMerge(state: MergeState): void;
  /** A pushed §16.4 error correlated to a mergeId (bind.ts routes it). */
  applyMergeError(mergeId: string, code: ErrorCode): void;
  /** Dismiss the advisory instrument for a session at its current ts. */
  dismissAdvisory(sessionId: string): void;
  reset(): void;
}

function scopeKeyOf(snapshot: {
  readonly scope: 'workstream' | 'detached';
  readonly workstream?: { readonly workstreamId: string };
}): string {
  return snapshot.scope === 'detached'
    ? DETACHED_SCOPE
    : (snapshot.workstream?.workstreamId ?? DETACHED_SCOPE);
}

/** Does a node belong to a detail-snapshot scope? (Re-baseline membership.) */
function inScope(node: WorkstreamNodeRecord, scopeKey: string): boolean {
  return scopeKey === DETACHED_SCOPE
    ? node.workstreamId === undefined
    : node.workstreamId === scopeKey;
}

/** Strip the decode-side `kind` discriminant off event-shaped records. */
function asNodeRecord(node: WorkstreamNodeRecord & { kind?: string }): WorkstreamNodeRecord {
  const { kind: _kind, ...record } = node;
  return record;
}

function asEdgeRecord(edge: WorkstreamEdgeRecord & { kind?: string }): WorkstreamEdgeRecord {
  const { kind: _kind, ...record } = edge;
  return record;
}

export const workstreamsStore = createStore<WorkstreamsStoreState>()((set) => ({
  rail: undefined,
  nodes: {},
  edges: {},
  edgeOrder: [],
  briefs: {},
  briefOrder: [],
  advisories: {},
  advisoryDismissedAt: {},
  merges: {},
  scopeCapturedAt: {},
  ceremony: undefined,

  applyBatch: (batch) => {
    if (batch.length === 0) return;
    set((s) => {
      let changed = false;
      let rail = s.rail;
      const nodes: Record<string, WorkstreamNodeRecord> = { ...s.nodes };
      const edges: Record<string, WorkstreamEdgeRecord> = { ...s.edges };
      let edgeOrder = [...s.edgeOrder];
      const briefs: Record<string, WorkstreamBriefPayload> = { ...s.briefs };
      let briefOrder = [...s.briefOrder];
      const advisories: Record<string, BranchAdvisory> = { ...s.advisories };
      const merges: Record<string, MergeState> = { ...s.merges };
      const scopeCapturedAt: Record<string, number> = { ...s.scopeCapturedAt };
      // Ceremony coalescing (DESIGN.md §3.3): newest EVENT edge in the batch.
      let ceremonyCandidate: WorkstreamEdgeRecord | undefined;

      for (const payload of batch) {
        switch (payload.kind) {
          case 'workstream-list-snapshot': {
            // Monotone on capturedAt: replays never regress the rail.
            if (rail !== undefined && rail.capturedAt > payload.capturedAt) break;
            rail = payload;
            changed = true;
            break;
          }
          case 'workstream-detail-snapshot': {
            const scopeKey = scopeKeyOf(payload);
            const watermark = scopeCapturedAt[scopeKey];
            if (watermark !== undefined && watermark > payload.capturedAt) break;
            scopeCapturedAt[scopeKey] = payload.capturedAt;
            // Re-baseline (§16.5): the snapshot is authoritative for its
            // scope — members not present in it are dropped.
            const kept = new Set(payload.nodes.map((n) => n.sessionId));
            for (const [sessionId, node] of Object.entries(nodes)) {
              if (inScope(node, scopeKey) && !kept.has(sessionId)) delete nodes[sessionId];
            }
            for (const node of payload.nodes) nodes[node.sessionId] = asNodeRecord(node);
            // Snapshot edges merge settled — append-only, NEVER ceremony.
            for (const edge of payload.edges) {
              if (edges[edge.edgeId] === undefined) {
                edges[edge.edgeId] = asEdgeRecord(edge);
                edgeOrder.push(edge.edgeId);
              }
            }
            changed = true;
            break;
          }
          case 'workstream-node': {
            nodes[payload.sessionId] = asNodeRecord(payload);
            changed = true;
            break;
          }
          case 'workstream-edge': {
            // Edges are immutable once recorded: a replayed edgeId is a no-op.
            if (edges[payload.edgeId] !== undefined) break;
            const record = asEdgeRecord(payload);
            edges[payload.edgeId] = record;
            edgeOrder.push(payload.edgeId);
            // A ledger-committed lineage EVENT — the one ceremony trigger.
            // Coalesce: only the newest (by ts, then batch order) arms.
            if (ceremonyCandidate === undefined || record.ts >= ceremonyCandidate.ts) {
              ceremonyCandidate = record;
            }
            changed = true;
            break;
          }
          case 'workstream-brief': {
            if (briefs[payload.briefId] === undefined) {
              briefOrder.push(payload.briefId);
            }
            briefs[payload.briefId] = payload;
            while (briefOrder.length > MAX_BRIEFS) {
              const evicted = briefOrder.shift();
              if (evicted !== undefined) delete briefs[evicted];
            }
            changed = true;
            break;
          }
          case 'branch-advisory': {
            const previous = advisories[payload.sessionId];
            // Monotone on ts: a replayed older advisory never resurfaces.
            if (previous !== undefined && previous.ts > payload.ts) break;
            advisories[payload.sessionId] = payload;
            changed = true;
            break;
          }
          case 'workstream-merge-resolved': {
            const previous = merges[payload.mergeId];
            merges[payload.mergeId] = {
              mergeId: payload.mergeId,
              phase: 'resolved',
              sessionId: payload.sessionId,
              briefId: payload.briefId,
              ...(previous?.parents !== undefined ? { parents: previous.parents } : {}),
            };
            changed = true;
            break;
          }
          default:
            // Exhaustive over the frozen union; opaque payloads are filtered
            // upstream (bind.ts) per the forward-tolerant reader rule.
            break;
        }
      }

      if (!changed) return s;
      return {
        rail,
        nodes,
        edges,
        edgeOrder,
        briefs,
        briefOrder,
        advisories,
        advisoryDismissedAt: s.advisoryDismissedAt,
        merges,
        scopeCapturedAt,
        ceremony:
          ceremonyCandidate === undefined
            ? s.ceremony
            : {
                edgeId: ceremonyCandidate.edgeId,
                toSessionId: ceremonyCandidate.toSessionId,
                epoch: (s.ceremony?.epoch ?? 0) + 1,
              },
      };
    });
  },

  trackMerge: (state) => {
    set((s) => ({ merges: { ...s.merges, [state.mergeId]: state } }));
  },

  applyMergeError: (mergeId, code) => {
    set((s) => {
      const previous = s.merges[mergeId];
      // A resolution already landed — the error is stale replay noise.
      if (previous?.phase === 'resolved') return s;
      return {
        merges: {
          ...s.merges,
          [mergeId]: {
            mergeId,
            phase: 'failed',
            code,
            ...(previous?.parents !== undefined ? { parents: previous.parents } : {}),
          },
        },
      };
    });
  },

  dismissAdvisory: (sessionId) => {
    set((s) => {
      const advisory = s.advisories[sessionId];
      if (advisory === undefined) return s;
      const mark = s.advisoryDismissedAt[sessionId];
      if (mark !== undefined && mark >= advisory.ts) return s;
      return {
        advisoryDismissedAt: { ...s.advisoryDismissedAt, [sessionId]: advisory.ts },
      };
    });
  },

  reset: () =>
    set({
      rail: undefined,
      nodes: {},
      edges: {},
      edgeOrder: [],
      briefs: {},
      briefOrder: [],
      advisories: {},
      advisoryDismissedAt: {},
      merges: {},
      scopeCapturedAt: {},
      ceremony: undefined,
    }),
}));

export type WorkstreamsStore = typeof workstreamsStore;

/**
 * Advisories currently VISIBLE as instrument states: the latest advisory per
 * session, unless dismissed at (or after) its ts. A NEWER advisory re-arms
 * the instrument (context pressure is a state, not a notification — no toast
 * re-spam for the same reading).
 */
export function activeAdvisories(
  state: Pick<WorkstreamsStoreState, 'advisories' | 'advisoryDismissedAt'>,
): readonly BranchAdvisory[] {
  const out: BranchAdvisory[] = [];
  for (const advisory of Object.values(state.advisories)) {
    const mark = state.advisoryDismissedAt[advisory.sessionId];
    if (mark !== undefined && mark >= advisory.ts) continue;
    out.push(advisory);
  }
  out.sort((a, b) => b.ts - a.ts || a.sessionId.localeCompare(b.sessionId));
  return out;
}
