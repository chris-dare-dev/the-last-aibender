/**
 * The workstream ENGINE — the gateway's {@link WorkstreamEnginePort} (BE-7;
 * ICR-0011, ws-protocol.md §16.3/§16.4): the ONE client lineage verb.
 *
 * Merge flow, exactly per §16.3: validate → record ONE new node with N
 * `merge_parent` edges + the mandatory merge brief ATOMICALLY (schema
 * `recordMerge` — a crash never leaves a merge node without its parents) →
 * fan out `workstream-merge-resolved` plus the node/edge/brief upserts.
 *
 * Error contract (§16.4), thrown as gateway `KernelVerbError`s:
 *   - `session-not-found`    a named parent has no session node;
 *   - `workstream-not-found` the named workstreamId is unknown;
 *   - `bad-request`          store-level shape refusals (identity screen on
 *                            the purpose-derived display name, parent
 *                            bounds, …);
 *   - anything else propagates → the gateway answers a GENERIC `internal`.
 *
 * DECISION OF RECORD (M4): the merge node is a LINEAGE entity (state
 * `idle`) — recordMerge is the frozen §16.3 mechanism, so the engine does
 * NOT spawn a kernel session here. Actually running the merge node is a
 * subsequent kernel launch that rides the recorder's `launch` action;
 * `params.purpose` lands on the node as its identifier-free display name
 * (and travels to the resume ledger when that launch happens).
 *
 * DRAFT FLOW (§16.2): merge-brief DRAFTS flow to the FE editor as
 * `workstream-brief` payloads (provenance `local-draft`/`refined` — the
 * qwen-produces/Claude-reviews split, briefs.ts) via
 * {@link WorkstreamEngine.draftMergeBrief}; drafts are published, never
 * persisted — the wire carries the FINAL text back in the merge request.
 */

import { readFileSync } from 'node:fs';

import type {
  WorkstreamBriefPayload,
  WorkstreamMergeRequest,
  WorkstreamMergeResolved,
} from '@aibender/protocol';
import {
  assertIdentityFreeColumn,
  LineageStoreError,
  type LineageStore,
  type SessionNodeRow,
} from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { KernelVerbError } from '../gateway/kernel.js';
import type { BranchDistillate, BriefSynthesizer, SynthesizedBrief } from './briefs.js';
import { createBriefSynthesizer } from './briefs.js';
import { edgeToWire, nodeToWire, type WorkstreamPublisher } from './wire.js';

/** The gateway port shape (structurally core/src/gateway/ports.ts). */
export interface WorkstreamEngine {
  merge(request: WorkstreamMergeRequest): Promise<WorkstreamMergeResolved>;
  /**
   * Produce and publish a conflict-surfacing merge-brief DRAFT for the FE
   * editor (per-branch distillates fused; disagreements surfaced, never
   * resolved). Returns the draft; publishes it as a `workstream-brief`
   * payload with a draft-minted id. Unknown parents → `session-not-found`.
   */
  draftMergeBrief(parents: readonly string[]): Promise<SynthesizedBrief>;
}

export interface WorkstreamEngineOptions {
  readonly store: LineageStore;
  readonly publish?: WorkstreamPublisher;
  /** Draft synthesis (briefs.ts). Default: deterministic-fallback-only. */
  readonly synthesizer?: BriefSynthesizer;
  /**
   * READ-ONLY transcript reader for per-branch distillation (native
   * compaction-summary reuse). Default reads the node's transcript_ref via
   * readFileSync; tests inject fixtures. Missing/unreadable → undefined.
   */
  readonly readTranscript?: (transcriptRef: string) => string | undefined;
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  /** Id factories (tests pin ids). */
  readonly newSessionId?: () => string;
  readonly newBriefId?: () => string;
  readonly newEdgeId?: () => string;
}

function defaultReadTranscript(transcriptRef: string): string | undefined {
  try {
    return readFileSync(transcriptRef, 'utf8');
  } catch {
    return undefined;
  }
}

export function createWorkstreamEngine(options: WorkstreamEngineOptions): WorkstreamEngine {
  const { store } = options;
  const nowMs = options.nowMs ?? Date.now;
  const synthesizer = options.synthesizer ?? createBriefSynthesizer();
  const readTranscript = options.readTranscript ?? defaultReadTranscript;
  const mintSessionId = options.newSessionId ?? (() => newId('ses'));
  const mintBriefId = options.newBriefId ?? (() => newId('br'));
  const mintEdgeId = options.newEdgeId ?? (() => newId('edg'));

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      options.logger?.error('workstream publish refused an engine payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  const publishListSnapshot = (): void => {
    publish({
      kind: 'workstream-list-snapshot',
      capturedAt: nowMs(),
      workstreams: store.workstreams.list().map((row) => ({
        workstreamId: row.id,
        title: row.title,
        status: row.status,
        ...(row.tags.length > 0 ? { tags: row.tags } : {}),
        nodeCount: store.nodes.list({ workstreamId: row.id }).length,
        updatedAt: row.updatedAtMs,
      })),
      detachedNodeCount: store.nodes.list({ detached: true }).length,
    });
  };

  const requireParentNodes = (parents: readonly string[]): SessionNodeRow[] =>
    parents.map((parent) => {
      const node = store.nodes.get(parent);
      if (node === undefined) {
        throw new KernelVerbError(
          'session-not-found',
          `merge parent ${parent} has no session node`,
        );
      }
      return node;
    });

  return {
    merge: async (request) => {
      const params = request.params;

      // -- semantic validation (§16.4 codes; shape was gateway-validated) ----
      requireParentNodes(params.parents);
      if (
        params.workstreamId !== undefined &&
        store.workstreams.get(params.workstreamId) === undefined
      ) {
        throw new KernelVerbError(
          'workstream-not-found',
          `unknown workstream ${params.workstreamId}`,
        );
      }
      // Pre-screen the purpose-derived display name BEFORE any write so an
      // identity-bearing purpose refuses cleanly with nothing landed [X2].
      try {
        assertIdentityFreeColumn('display_name', params.purpose);
      } catch (cause) {
        throw new KernelVerbError('bad-request', (cause as Error).message);
      }

      // -- the mandatory merge brief (kind merge; wire carries FINAL text) ---
      let briefId: string;
      try {
        briefId = store.briefs.insert({
          id: mintBriefId(),
          kind: 'merge',
          bodyMd: params.briefBody,
          sourceNodes: params.parents,
          provenance: 'refined',
        }).id;
      } catch (cause) {
        if (cause instanceof LineageStoreError) {
          throw new KernelVerbError('bad-request', cause.message);
        }
        throw cause;
      }

      // -- ONE new node + N merge_parent edges, one transaction (§16.3) ------
      const sessionId = mintSessionId();
      let recorded;
      try {
        recorded = store.recordMerge({
          node: {
            id: sessionId,
            ...(params.workstreamId !== undefined ? { workstreamId: params.workstreamId } : {}),
            backend: params.backend,
            account: params.accountLabel,
            cwd: params.cwd,
            displayName: params.purpose,
            state: 'idle',
            origin: 'harness',
            confidence: 'recorded',
          },
          parents: params.parents,
          briefId,
          edgeIds: params.parents.map(() => mintEdgeId()),
        });
      } catch (cause) {
        if (cause instanceof LineageStoreError) {
          throw new KernelVerbError('bad-request', cause.message);
        }
        throw cause;
      }

      // -- fan-out: brief + node + edges + refreshed rail (§16.3/§16.5) ------
      const briefPayload: WorkstreamBriefPayload = {
        kind: 'workstream-brief',
        briefId,
        briefKind: 'merge',
        body: params.briefBody,
        sourceSessionIds: params.parents,
        provenance: 'refined',
        createdAt: nowMs(),
        ...(params.workstreamId !== undefined ? { workstreamId: params.workstreamId } : {}),
      };
      publish(briefPayload);
      publish({ kind: 'workstream-node', ...nodeToWire(recorded.node) });
      for (const edge of recorded.edges) {
        publish({ kind: 'workstream-edge', ...edgeToWire(edge) });
      }
      publishListSnapshot();

      return {
        kind: 'workstream-merge-resolved',
        mergeId: request.mergeId,
        sessionId,
        briefId,
      };
    },

    draftMergeBrief: async (parents) => {
      const nodes = requireParentNodes(parents);
      const branches: BranchDistillate[] = [];
      for (const node of nodes) {
        const transcriptText =
          node.transcriptRef !== null ? readTranscript(node.transcriptRef) : undefined;
        const distilled = await synthesizer.distill({
          goal: 'branch distillate for a merge',
          sessionId: node.id,
          ...(transcriptText !== undefined ? { transcriptText } : {}),
          ...(node.cwd !== null ? { contextLines: [`cwd: ${node.cwd}`] } : {}),
        });
        branches.push({ sessionId: node.id, body: distilled.body });
      }
      const draft = await synthesizer.synthesizeMergeBrief({ branches });
      // Drafts are PUBLISHED for the editor, never persisted (§16.2).
      publish({
        kind: 'workstream-brief',
        briefId: mintBriefId(),
        briefKind: 'merge',
        body: draft.body,
        sourceSessionIds: parents,
        provenance: draft.provenance,
        createdAt: nowMs(),
      });
      return draft;
    },
  };
}
