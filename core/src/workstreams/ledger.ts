/**
 * The workstream LEDGER surface (BE-7; plan §4/BE-7 item 1, blueprint §5):
 * create/list/detail workstreams over schema migration 0003, plus the §16.5
 * snapshot builders/publication the broker pushes "on boot and on change".
 *
 * This module is the READ/CRUD half; action-time node/edge recording lives
 * in recorder.ts (the frozen ws-protocol.md §15.1 port), the merge verb in
 * engine.ts. All three share ONE LineageStore (the kernel database,
 * sqlite-ddl.md §8.1) and ONE publisher.
 *
 * [X2]: everything published rides the wire projections in wire.ts — no
 * native id can reach the channel from here by construction.
 */

import type { WorkstreamStatus } from '@aibender/protocol';
import type { LineageStore, WorkstreamRow } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import type {
  WorkstreamDetailSnapshot,
  WorkstreamListSnapshot,
} from '@aibender/protocol';
import { edgeToWire, nodeToWire, summaryOfWorkstream, type WorkstreamPublisher } from './wire.js';

export interface CreateWorkstreamInput {
  /** Identifier-free title [X2] (screened at insert by the store). */
  readonly title: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly status?: WorkstreamStatus;
}

export interface WorkstreamLedger {
  /** Create a workstream (harness id minted here) and publish the new rail. */
  createWorkstream(input: CreateWorkstreamInput): WorkstreamRow;
  /** All workstreams, oldest first (optionally filtered by status). */
  listWorkstreams(filter?: {
    readonly statuses?: readonly WorkstreamStatus[];
  }): readonly WorkstreamRow[];
  getWorkstream(id: string): WorkstreamRow | undefined;
  setStatus(id: string, status: WorkstreamStatus): WorkstreamRow;
  rename(id: string, title: string): WorkstreamRow;
  setTags(id: string, tags: readonly string[]): WorkstreamRow;
  /** Assign / reassign / detach (null) a node; publishes the node upsert. */
  assignNode(sessionId: string, workstreamId: string | null): void;
  /** The §16.1 rail snapshot (summaries + detached-HEAD orphan count). */
  listSnapshot(): WorkstreamListSnapshot;
  /** One workstream's full graph (scope `workstream`). */
  detailSnapshot(workstreamId: string): WorkstreamDetailSnapshot;
  /** The detached-HEAD bucket (scope `detached` — FORBIDS a summary). */
  detachedSnapshot(): WorkstreamDetailSnapshot;
  /** §16.5 "on boot": push the current list snapshot. */
  publishListSnapshot(): void;
  publishDetailSnapshot(scope: { readonly workstreamId: string } | 'detached'): void;
}

export interface WorkstreamLedgerOptions {
  readonly store: LineageStore;
  /** The gateway `publishWorkstream` binding. Absent → ledger-only mode. */
  readonly publish?: WorkstreamPublisher;
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  /** Id factory (tests pin ids). Default `newId('ws')`. */
  readonly newWorkstreamId?: () => string;
}

export function createWorkstreamLedger(options: WorkstreamLedgerOptions): WorkstreamLedger {
  const { store } = options;
  const nowMs = options.nowMs ?? Date.now;
  const mintId = options.newWorkstreamId ?? (() => newId('ws'));

  /** Publish is best-effort here: a refusing publisher must never corrupt CRUD. */
  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      options.logger?.error('workstream publish refused a ledger payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  const nodeCountFor = (workstreamId: string): number =>
    store.nodes.list({ workstreamId }).length;

  const listSnapshot = (): WorkstreamListSnapshot => ({
    kind: 'workstream-list-snapshot',
    capturedAt: nowMs(),
    workstreams: store.workstreams
      .list()
      .map((row) => summaryOfWorkstream(row, nodeCountFor(row.id))),
    detachedNodeCount: store.nodes.list({ detached: true }).length,
  });

  const detailSnapshot = (workstreamId: string): WorkstreamDetailSnapshot => {
    const row = store.workstreams.get(workstreamId);
    if (row === undefined) {
      throw new RangeError(`no workstream row for ${workstreamId}`);
    }
    const nodes = store.nodes.list({ workstreamId });
    const nodeIds = new Set(nodes.map((node) => node.id));
    // Edges belong to the detail when they TOUCH the workstream's nodes.
    const edges = store.edges
      .list()
      .filter(
        (edge) =>
          nodeIds.has(edge.toNode) || (edge.fromNode !== null && nodeIds.has(edge.fromNode)),
      );
    return {
      kind: 'workstream-detail-snapshot',
      capturedAt: nowMs(),
      scope: 'workstream',
      workstream: summaryOfWorkstream(row, nodes.length),
      nodes: nodes.map(nodeToWire),
      edges: edges.map(edgeToWire),
    };
  };

  const detachedSnapshot = (): WorkstreamDetailSnapshot => {
    const nodes = store.nodes.list({ detached: true });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = store.edges
      .list()
      .filter(
        (edge) =>
          nodeIds.has(edge.toNode) || (edge.fromNode !== null && nodeIds.has(edge.fromNode)),
      );
    return {
      kind: 'workstream-detail-snapshot',
      capturedAt: nowMs(),
      scope: 'detached',
      nodes: nodes.map(nodeToWire),
      edges: edges.map(edgeToWire),
    };
  };

  return {
    createWorkstream: (input) => {
      const row = store.workstreams.insert({
        id: mintId(),
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      publish(listSnapshot());
      return row;
    },

    listWorkstreams: (filter) => store.workstreams.list(filter),
    getWorkstream: (id) => store.workstreams.get(id),

    setStatus: (id, status) => {
      const row = store.workstreams.setStatus(id, status);
      publish(listSnapshot());
      return row;
    },

    rename: (id, title) => {
      const row = store.workstreams.rename(id, title);
      publish(listSnapshot());
      return row;
    },

    setTags: (id, tags) => {
      const row = store.workstreams.setTags(id, tags);
      publish(listSnapshot());
      return row;
    },

    assignNode: (sessionId, workstreamId) => {
      const row = store.nodes.assignWorkstream(sessionId, workstreamId);
      publish({ kind: 'workstream-node', ...nodeToWire(row) });
      publish(listSnapshot());
    },

    listSnapshot,
    detailSnapshot,
    detachedSnapshot,

    publishListSnapshot: () => publish(listSnapshot()),
    publishDetailSnapshot: (scope) =>
      publish(scope === 'detached' ? detachedSnapshot() : detailSnapshot(scope.workstreamId)),
  };
}
