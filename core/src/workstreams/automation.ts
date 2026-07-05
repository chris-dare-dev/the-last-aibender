/**
 * The [X4] brief-automation handlers (BE-7; plan §4/BE-7 item 3;
 * hooks-contract.md §7.1) — the {@link WorkstreamHookRouting} port BE-7
 * registers with BE-5's accepting endpoint:
 *
 *   SessionEnd   → the auto continuation brief (POST-ACK fire-and-forget);
 *   PreCompact   → full-fidelity snapshot brief + `compact` edge
 *                  (POST-ACK fire-and-forget);
 *   SessionStart → the brief-injection response (deadline-raced by the
 *                  collector; frozen HookSessionStartOutput shape).
 *
 * IDEMPOTENCE (the frozen row): duplicate posts of the same
 * (hook_event_name, session_id) produce ONE brief — the dedupe key is
 * exactly that pair (hooks retry; the CLI never re-fires a lifecycle event
 * for the same session in a way this cares about at M4).
 *
 * NODE RESOLUTION: hook bodies carry NATIVE session ids for HARNESS AND
 * EXTERNAL sessions alike (the account-wide template rule). The handlers
 * resolve native → node via the lineage store; an UNKNOWN native id is
 * skipped and counted — registering external sessions is the reconciler's
 * job, never a hook side effect (single-writer discipline).
 *
 * THE COMPACT EDGE (decision of record, M4): the store refuses non-continue
 * self-edges (sqlite-ddl.md §8.5), so the in-place compaction moment is
 * recorded as a PRE-COMPACT SNAPSHOT NODE (a completed archive marker
 * carrying the transcript ref — "the harness keeps the full-fidelity
 * history even after native compaction", x4-workstreams) with a `compact`
 * edge INTO the live node. The live node keeps its identity, its native-id
 * resolution (byNativeSessionId is oldest-first and the snapshot node
 * carries NO native id), and all future activity.
 *
 * SESSIONSTART POLICY (blueprint §5): inject on `resume` / `clear` /
 * `compact`; never on `startup` (configurable). The injected body is the
 * workstream's LATEST brief (kinds session-end · pre-compact · merge),
 * scoped to briefs sourced from the node's workstream — or from the node
 * itself when detached. Paths + session ids + labels only [X2].
 *
 * Handlers never throw and never block the ack path: the async work is
 * tracked so tests (and orderly shutdown) can `settle()` it.
 */

import { readFileSync } from 'node:fs';

import type {
  AcceptedHookPost,
  HookSessionStartOutput,
  WorkstreamHookRouting,
} from '@aibender/protocol';
import type { BriefRow, LineageStore, SessionNodeRow } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import type { BriefSynthesizer } from './briefs.js';
import { createBriefSynthesizer } from './briefs.js';
import { edgeToWire, nodeToWire, type WorkstreamPublisher } from './wire.js';

export interface WorkstreamHookAutomationStats {
  readonly briefsCreated: number;
  readonly duplicatesSuppressed: number;
  readonly unknownSessionsSkipped: number;
  readonly injectionsAnswered: number;
  readonly compactEdgesRecorded: number;
  readonly failures: number;
}

export interface WorkstreamHookAutomation extends WorkstreamHookRouting {
  /**
   * The routing slots are OPTIONAL on the frozen port (an unregistered slot
   * keeps the M3 behavior); THIS handle always provides all three —
   * declared required here so consumers (and tests) invoke them without
   * existence checks. `onSessionStart` answers synchronously (store reads
   * only) — the port's Promise form stays available to other implementors.
   */
  onSessionEnd(post: AcceptedHookPost): void;
  onPreCompact(post: AcceptedHookPost): void;
  onSessionStart(post: AcceptedHookPost): HookSessionStartOutput | undefined;
  /** Await all in-flight fire-and-forget handler work (tests/shutdown). */
  settle(): Promise<void>;
  stats(): WorkstreamHookAutomationStats;
}

export interface WorkstreamHookAutomationOptions {
  readonly store: LineageStore;
  readonly publish?: WorkstreamPublisher;
  /** Brief synthesis (briefs.ts). Default: deterministic-fallback-only. */
  readonly synthesizer?: BriefSynthesizer;
  /**
   * READ-ONLY transcript reader (native-summary reuse). Default readFileSync
   * with failure → undefined; tests inject fixtures. NEVER a write path.
   */
  readonly readTranscript?: (path: string) => string | undefined;
  /** SessionStart sources that receive an injection. Default resume/clear/compact. */
  readonly injectOnSources?: readonly string[];
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  readonly newBriefId?: () => string;
  readonly newEdgeId?: () => string;
  readonly newSnapshotNodeId?: () => string;
}

const DEFAULT_INJECT_SOURCES = Object.freeze(['resume', 'clear', 'compact']);

const AUTOMATION_BRIEF_KINDS = Object.freeze(['session-end', 'pre-compact', 'merge'] as const);

function defaultReadTranscript(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function stringField(post: AcceptedHookPost, key: string): string | undefined {
  const value = post.body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createWorkstreamHookAutomation(
  options: WorkstreamHookAutomationOptions,
): WorkstreamHookAutomation {
  const { store } = options;
  const logger = options.logger;
  const nowMs = options.nowMs ?? Date.now;
  const synthesizer = options.synthesizer ?? createBriefSynthesizer();
  const readTranscript = options.readTranscript ?? defaultReadTranscript;
  const injectSources = options.injectOnSources ?? DEFAULT_INJECT_SOURCES;
  const mintBriefId = options.newBriefId ?? (() => newId('br'));
  const mintEdgeId = options.newEdgeId ?? (() => newId('edg'));
  const mintSnapshotNodeId = options.newSnapshotNodeId ?? (() => newId('ses'));

  const stats = {
    briefsCreated: 0,
    duplicatesSuppressed: 0,
    unknownSessionsSkipped: 0,
    injectionsAnswered: 0,
    compactEdgesRecorded: 0,
    failures: 0,
  };

  /** (hook_event_name, native session id) → brief-produced (the frozen key). */
  const produced = new Set<string>();
  const pending = new Set<Promise<void>>();

  const track = (work: Promise<void>): void => {
    const settled = work.catch((cause: unknown) => {
      stats.failures += 1;
      logger?.error('workstream hook automation handler failed (swallowed)', {
        detail: (cause as Error).message,
      });
    });
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  };

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      logger?.error('workstream publish refused an automation payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  const resolveNode = (post: AcceptedHookPost): SessionNodeRow | undefined => {
    const node = store.nodes.byNativeSessionId(post.nativeSessionId);
    if (node === undefined) stats.unknownSessionsSkipped += 1;
    return node;
  };

  /**
   * THE frozen idempotence key: (hook_event_name, native session id), NUL-
   * separated so no name/id concatenation can collide.
   */
  const producedKey = (post: AcceptedHookPost): string =>
    `${post.hookEventName}\u0000${post.nativeSessionId}`;

  /**
   * True when this (event, session) pair already produced its brief. A pure
   * CHECK — the key is consumed by {@link markProduced} only after node
   * resolution succeeds, so an unknown-native-id skip does NOT burn the key
   * (the reconciler may register the session later; a retried post then
   * still produces its one brief).
   */
  const alreadyProduced = (post: AcceptedHookPost): boolean => {
    if (produced.has(producedKey(post))) {
      stats.duplicatesSuppressed += 1;
      return true;
    }
    return false;
  };

  /** Consume the dedupe key (same session_id + event -> ONE brief). */
  const markProduced = (post: AcceptedHookPost): void => {
    produced.add(producedKey(post));
  };

  const insertAndPublishBrief = (input: {
    readonly kind: 'session-end' | 'pre-compact' | 'session-start-injection';
    readonly body: string;
    readonly node: SessionNodeRow;
    readonly provenance: BriefRow['provenance'];
  }): BriefRow => {
    const brief = store.briefs.insert({
      id: mintBriefId(),
      kind: input.kind,
      bodyMd: input.body,
      sourceNodes: [input.node.id],
      provenance: input.provenance,
    });
    stats.briefsCreated += 1;
    publish({
      kind: 'workstream-brief',
      briefId: brief.id,
      briefKind: brief.kind,
      body: brief.bodyMd,
      sourceSessionIds: brief.sourceNodes,
      provenance: brief.provenance,
      createdAt: brief.createdAtMs,
      ...(input.node.workstreamId !== null ? { workstreamId: input.node.workstreamId } : {}),
    });
    return brief;
  };

  const distillFor = async (
    node: SessionNodeRow,
    post: AcceptedHookPost,
    goal: string,
  ): Promise<{ readonly body: string; readonly provenance: BriefRow['provenance'] }> => {
    const transcriptPath = stringField(post, 'transcript_path') ?? node.transcriptRef ?? undefined;
    const transcriptText =
      transcriptPath !== undefined ? readTranscript(transcriptPath) : undefined;
    const contextLines = [
      `session: ${node.id}`,
      `account: ${node.account}`,
      ...(node.cwd !== null ? [`cwd: ${node.cwd}`] : []),
      ...(transcriptPath !== undefined ? [`transcript: ${transcriptPath}`] : []),
    ];
    return synthesizer.distill({
      goal,
      sessionId: node.id,
      ...(transcriptText !== undefined ? { transcriptText } : {}),
      contextLines,
    });
  };

  /** The workstream's latest automation brief for injection (see module doc). */
  const latestBriefFor = (node: SessionNodeRow): BriefRow | undefined => {
    const scopeNodeIds =
      node.workstreamId !== null
        ? new Set(store.nodes.list({ workstreamId: node.workstreamId }).map((row) => row.id))
        : new Set([node.id]);
    const candidates = store.briefs
      .list({ kinds: AUTOMATION_BRIEF_KINDS })
      .filter((brief) => brief.sourceNodes.some((source) => scopeNodeIds.has(source)));
    return candidates.at(-1); // store lists oldest-first
  };

  return {
    onSessionEnd: (post) => {
      if (alreadyProduced(post)) return;
      const node = resolveNode(post);
      if (node === undefined) return;
      markProduced(post);
      track(
        (async () => {
          const distilled = await distillFor(node, post, 'continuation brief (session ended)');
          insertAndPublishBrief({
            kind: 'session-end',
            body: distilled.body,
            node,
            provenance: distilled.provenance,
          });
          // The session ended: settle the LINEAGE state (a different axis
          // from the resume-ledger process FSM) + last-activity snapshot.
          if (node.state === 'running' || node.state === 'idle') {
            store.nodes.setState(node.id, 'completed');
          }
          store.nodes.updateSnapshots(node.id, { lastActiveAtMs: nowMs() });
          publish({ kind: 'workstream-node', ...nodeToWire(store.nodes.get(node.id) ?? node) });
        })(),
      );
    },

    onPreCompact: (post) => {
      if (alreadyProduced(post)) return;
      const node = resolveNode(post);
      if (node === undefined) return;
      markProduced(post);
      track(
        (async () => {
          const distilled = await distillFor(
            node,
            post,
            'pre-compaction snapshot (full-fidelity anchor)',
          );
          const brief = insertAndPublishBrief({
            kind: 'pre-compact',
            body: distilled.body,
            node,
            provenance: distilled.provenance,
          });
          // The snapshot node: a completed archive marker carrying the
          // transcript ref (NO native id — resolution stays on the live node).
          const trigger = stringField(post, 'trigger');
          const transcriptPath =
            stringField(post, 'transcript_path') ?? node.transcriptRef ?? undefined;
          const snapshot = store.nodes.insert({
            id: mintSnapshotNodeId(),
            ...(node.workstreamId !== null ? { workstreamId: node.workstreamId } : {}),
            backend: node.backend,
            account: node.account,
            ...(transcriptPath !== undefined ? { transcriptRef: transcriptPath } : {}),
            ...(node.cwd !== null ? { cwd: node.cwd } : {}),
            displayName: 'pre-compact snapshot',
            state: 'completed',
            origin: 'harness',
            confidence: 'recorded',
          });
          publish({ kind: 'workstream-node', ...nodeToWire(snapshot) });
          const edge = store.edges.insert({
            id: mintEdgeId(),
            fromNode: snapshot.id,
            toNode: node.id,
            edgeType: 'compact',
            briefId: brief.id,
            confidence: 'recorded',
            metadataJson: JSON.stringify({
              reason: 'pre-compact',
              ...(trigger !== undefined ? { trigger } : {}),
            }),
          });
          stats.compactEdgesRecorded += 1;
          publish({ kind: 'workstream-edge', ...edgeToWire(edge) });
        })(),
      );
    },

    onSessionStart: (post) => {
      const source = stringField(post, 'source');
      if (source === undefined || !injectSources.includes(source)) return undefined;
      const node = resolveNode(post);
      if (node === undefined) return undefined;
      const latest = latestBriefFor(node);
      if (latest === undefined) return undefined;
      const body =
        `## Workstream brief (${latest.kind}, ${latest.provenance})\n\n${latest.bodyMd}`;
      // Record WHAT was injected — once per (SessionStart, session id); the
      // response itself is computed for every accepted start.
      if (!alreadyProduced(post)) {
        markProduced(post);
        try {
          insertAndPublishBrief({
            kind: 'session-start-injection',
            body,
            node,
            provenance: latest.provenance,
          });
        } catch (cause) {
          stats.failures += 1;
          logger?.error('session-start injection record failed (response still served)', {
            detail: (cause as Error).message,
          });
        }
      }
      stats.injectionsAnswered += 1;
      const output: HookSessionStartOutput = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: body,
        },
      };
      return output;
    },

    settle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },

    stats: () => ({ ...stats }),
  };
}
