/**
 * THE {@link LineageRecorder} implementation (BE-7; ws-protocol.md §15.1,
 * blueprint §5 recording discipline) — typed nodes+edges recorded AT ACTION
 * TIME over the schema lineage store, in the SAME kernel database (and thus
 * the same synchronous SQLite commit scope) as the resume-ledger row the
 * action wrote (sqlite-ddl.md §8.1 reason 1).
 *
 * Frozen contract honored here:
 *   - `record` NEVER throws (fire-and-forget for the caller): every path is
 *     wrapped; failures are logged and swallowed — a recorder bug must never
 *     take a session down.
 *   - Every kernel-mediated action lands `confidence: 'recorded'`,
 *     `origin: 'harness'`. The reconciler covers EXTERNAL sessions only and
 *     never rides this port (reconciler.ts).
 *   - launch → new `session_node` (the resume-ledger id IS the node id);
 *     resume → `continue` edge (self-edge for in-place dead resume);
 *     fork → `fork` edge; recycle → `continue` edge with
 *     `metadata.reason = 'recycle'` (+ checkpointRef) — the generalized M2
 *     `ContinuationEdgeEmitter`; merge → N `merge_parent` edges into the
 *     (already-materialized) merge node, one transaction.
 *   - Endpoint materialization: an edge whose endpoint has no node row yet
 *     (e.g. a ptyHost recycle edge for a session launched before this
 *     recorder was composed) is healed from the RESUME LEDGER row when one
 *     is available — account/backend/cwd come from the row, never guessed.
 *     No ledger row and no node → the action is logged and dropped (the
 *     recorder never invents attribution [X2]).
 *
 * `workstreamHint` resolution (launch): an exact workstream ID match wins;
 * else an exact TITLE match; else the node stays detached (hints are hints).
 *
 * Wire fan-out: every recorded node/edge publishes its §16.1 upsert/append
 * through the shared publisher (wrapped — publish failures are logged, the
 * store row stands).
 */

import type {
  LineageAction,
  LineageLaunchAction,
  LineageRecorder,
  SessionEdgeType,
} from '@aibender/protocol';
import type {
  LineageStore,
  NewSessionEdgeRow,
  ResumeLedgerStore,
  SessionNodeRow,
} from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { edgeToWire, nodeToWire, type WorkstreamPublisher } from './wire.js';

export interface LedgerLineageRecorderStats {
  readonly recorded: number;
  readonly dropped: number;
}

/** The recorder plus the non-port surfaces the composition root wires. */
export interface LedgerLineageRecorder extends LineageRecorder {
  /**
   * Write-once native-id backfill onto the node (the resume-ledger rule) —
   * called from the composition root's message tap when the init message
   * surfaces the native id. Never throws (tap discipline, ICR-0009).
   */
  backfillNativeSessionId(sessionId: string, nativeSessionId: string): void;
  /** Activity snapshot for the node card. Never throws. */
  noteActivity(sessionId: string, atEpochMs: number): void;
  stats(): LedgerLineageRecorderStats;
}

export interface LineageRecorderOptions {
  readonly store: LineageStore;
  /**
   * Endpoint-healing source (see module doc). The composition root passes
   * the SAME resume ledger the kernel writes.
   */
  readonly resumeLedger?: ResumeLedgerStore;
  readonly publish?: WorkstreamPublisher;
  readonly logger?: Logger;
  /** Edge-id factory (tests pin ids). Default `newId('edg')`. */
  readonly newEdgeId?: () => string;
}

export function createLineageRecorder(options: LineageRecorderOptions): LedgerLineageRecorder {
  const { store } = options;
  const logger = options.logger;
  const mintEdgeId = options.newEdgeId ?? (() => newId('edg'));
  const stats = { recorded: 0, dropped: 0 };

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      logger?.error('workstream publish refused a recorder payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  const publishNode = (row: SessionNodeRow): void =>
    publish({ kind: 'workstream-node', ...nodeToWire(row) });

  /** Hint → workstream id: exact id match, else exact title match, else none. */
  const resolveWorkstreamHint = (hint: string | undefined): string | undefined => {
    if (hint === undefined) return undefined;
    if (store.workstreams.get(hint) !== undefined) return hint;
    const byTitle = store.workstreams.list().find((row) => row.title === hint);
    return byTitle?.id;
  };

  const insertLaunchNode = (action: LineageLaunchAction): SessionNodeRow | undefined => {
    const existing = store.nodes.get(action.sessionId);
    if (existing !== undefined) return existing; // idempotent (duplicate action)
    const workstreamId = resolveWorkstreamHint(action.workstreamHint);
    return store.nodes.insert({
      id: action.sessionId,
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      backend: action.backend,
      account: action.accountLabel,
      cwd: action.cwd,
      state: 'running',
      origin: 'harness',
      confidence: 'recorded',
    });
  };

  /**
   * Ensure a node row exists for an edge endpoint: existing row wins; else
   * heal from the resume ledger; else undefined (drop — never guess [X2]).
   */
  const ensureNode = (sessionId: string): SessionNodeRow | undefined => {
    const existing = store.nodes.get(sessionId);
    if (existing !== undefined) return existing;
    const row = options.resumeLedger?.get(sessionId);
    if (row === undefined) return undefined;
    const workstreamId = resolveWorkstreamHint(row.workstreamHint ?? undefined);
    const node = store.nodes.insert({
      id: row.id,
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      backend: row.backend,
      account: row.accountLabel,
      cwd: row.cwd,
      state: 'running',
      origin: 'harness',
      confidence: 'recorded',
    });
    if (row.nativeSessionId !== null) {
      store.nodes.backfillNativeSessionId(row.id, row.nativeSessionId);
    }
    publishNode(store.nodes.get(row.id) ?? node);
    return node;
  };

  const insertEdge = (input: {
    readonly fromSessionId: string;
    readonly toSessionId: string;
    readonly edgeType: SessionEdgeType;
    readonly briefId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): void => {
    if (ensureNode(input.fromSessionId) === undefined) {
      throw new Error(`edge endpoint ${input.fromSessionId} has no node and no ledger row`);
    }
    if (ensureNode(input.toSessionId) === undefined) {
      throw new Error(`edge endpoint ${input.toSessionId} has no node and no ledger row`);
    }
    const row: NewSessionEdgeRow = {
      id: mintEdgeId(),
      fromNode: input.fromSessionId,
      toNode: input.toSessionId,
      edgeType: input.edgeType,
      ...(input.briefId !== undefined ? { briefId: input.briefId } : {}),
      confidence: 'recorded',
      ...(input.metadata !== undefined ? { metadataJson: JSON.stringify(input.metadata) } : {}),
    };
    const inserted = store.edges.insert(row);
    publish({ kind: 'workstream-edge', ...edgeToWire(inserted) });
  };

  const recordUnsafe = (action: LineageAction): void => {
    switch (action.kind) {
      case 'launch': {
        const node = insertLaunchNode(action);
        if (node !== undefined) publishNode(node);
        return;
      }
      case 'resume':
        // A continuation is a CHILD; in-place dead resume is the legal
        // continue SELF-edge (from === to, the M2 convention).
        insertEdge({
          fromSessionId: action.fromSessionId,
          toSessionId: action.toSessionId,
          edgeType: 'continue',
        });
        return;
      case 'fork':
        insertEdge({
          fromSessionId: action.fromSessionId,
          toSessionId: action.toSessionId,
          edgeType: 'fork',
        });
        return;
      case 'recycle':
        // Blueprint §4.1: recycle = checkpoint → kill → continuation, a
        // `continue` edge with recycle provenance in metadata.
        insertEdge({
          fromSessionId: action.fromSessionId,
          toSessionId: action.toSessionId,
          edgeType: 'continue',
          metadata: {
            reason: 'recycle',
            ...(action.checkpointRef !== undefined
              ? { checkpointRef: action.checkpointRef }
              : {}),
          },
        });
        return;
      case 'merge': {
        // X-1 [X4]: a merge is a SYNTHESIS seeded by the conflict-surfacing
        // brief (blueprint §5 "merge = synthesis, not concatenation"). REQUIRE
        // the briefId here — the port type now mandates it, and this runtime
        // guard rejects a bypassing (external / plain-JS) caller too. A merge
        // recorded without its brief would create merge_parent edges with no
        // conflict narrative — a conflict-BLIND merge the UI renders as
        // complete. `record` swallows this throw as a DROPPED action (never a
        // silent partial merge). Guard BEFORE any store write so nothing lands.
        if (typeof action.briefId !== 'string' || action.briefId.length === 0) {
          throw new Error(
            'merge requires a conflict-surfacing briefId (blueprint §5; ws-protocol.md §16.2)',
          );
        }
        // THE atomic merge path (node + N merge_parent edges + mandatory
        // brief in one transaction) is the engine's `store.recordMerge`
        // (engine.ts, ws-protocol.md §16.3). This port covers the case
        // where the merge NODE already exists (e.g. a kernel-launched merge
        // session recorded via `launch` first): every endpoint is validated
        // UP FRONT so the sequential edge inserts below can only fail on a
        // store-level anomaly — never on caller input.
        for (const parent of action.parentSessionIds) {
          if (store.nodes.get(parent) === undefined) {
            throw new Error(`merge parent ${parent} has no session node`);
          }
        }
        if (ensureNode(action.toSessionId) === undefined) {
          throw new Error(`merge node ${action.toSessionId} has no node and no ledger row`);
        }
        const wires: NewSessionEdgeRow[] = action.parentSessionIds.map((parent) => ({
          id: mintEdgeId(),
          fromNode: parent,
          toNode: action.toSessionId,
          edgeType: 'merge_parent' as const,
          briefId: action.briefId,
          confidence: 'recorded' as const,
        }));
        for (const wire of wires) {
          const edge = store.edges.insert(wire);
          publish({ kind: 'workstream-edge', ...edgeToWire(edge) });
        }
        return;
      }
    }
  };

  return {
    record: (action) => {
      try {
        recordUnsafe(action);
        stats.recorded += 1;
      } catch (cause) {
        stats.dropped += 1;
        logger?.error('lineage recorder dropped an action (record must not throw)', {
          kind: (action as { kind?: string }).kind ?? 'unknown',
          detail: (cause as Error).message,
        });
      }
    },

    backfillNativeSessionId: (sessionId, nativeSessionId) => {
      try {
        if (store.nodes.get(sessionId) === undefined) return; // node not recorded — nothing to backfill
        store.nodes.backfillNativeSessionId(sessionId, nativeSessionId);
      } catch (cause) {
        logger?.warn('lineage native-id backfill dropped', {
          sessionId,
          detail: (cause as Error).message,
        });
      }
    },

    noteActivity: (sessionId, atEpochMs) => {
      try {
        if (store.nodes.get(sessionId) === undefined) return;
        store.nodes.updateSnapshots(sessionId, { lastActiveAtMs: atEpochMs });
      } catch (cause) {
        logger?.warn('lineage activity snapshot dropped', {
          sessionId,
          detail: (cause as Error).message,
        });
      }
    },

    stats: () => ({ ...stats }),
  };
}
