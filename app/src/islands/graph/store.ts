/**
 * FE-4 GraphStore — the graphology data model fed by validated
 * `context-touch` payloads (ws-protocol.md §12), stage one of the normative
 * GraphStore → LayoutBridge → GraphRenderer contract.
 *
 * Incremental protocol (blueprint §8 / findings §"Incremental-insertion
 * protocol", plan §9.2 FE-4 positive row):
 *
 *   - touches are QUEUED, never applied per-event; one commit per rAF (or a
 *     150 ms window where rAF is absent) coalesces the batch;
 *   - a new node SPAWNS AT ITS REFERRER's current position (+ deterministic
 *     jitter) — never the origin fling;
 *   - a re-touch of an existing artifact emits a PULSE for that node only
 *     (the amber pulse fires for the actively-touched artifact and nothing
 *     else);
 *   - the store emits one {@link GraphMutationBatch} per commit; the bridge
 *     answers with a single gentle reheat.
 *
 * The store owns DATA ONLY: node/edge identity, kinds, clusters, spawn
 * positions. Positions live on the layout axis (bridge epochs); view state
 * (layers, cluster focus, camera) lives in the island controller.
 *
 * [X2]: everything stored derives from file paths + session ids + the
 * frozen relation vocabulary. No identity-bearing attribute exists.
 */

import { UndirectedGraph } from 'graphology';
import type { ContextGraphTouch } from '@aibender/protocol';
import { classifyArtifact, upgradeKind } from './classify.ts';
import type { GraphEdgeRecord, GraphMutationBatch, GraphNodeKind, GraphNodeRecord } from './types.ts';

/** Schedules exactly one upcoming commit; returns a cancel function. */
export type CommitScheduler = (flush: () => void) => () => void;

/** The batching window where rAF is unavailable (plan: "per rAF/150 ms"). */
export const FALLBACK_COMMIT_WINDOW_MS = 150;

/** rAF where present (the WKWebView path), else the 150 ms window. */
export const defaultCommitScheduler: CommitScheduler = (flush) => {
  const g = globalThis as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame === 'function') {
    const handle = g.requestAnimationFrame(() => flush());
    return () => g.cancelAnimationFrame?.(handle);
  }
  const handle = setTimeout(flush, FALLBACK_COMMIT_WINDOW_MS);
  return () => clearTimeout(handle);
};

/** Deterministic PRNG for spawn jitter (mulberry32 — synthesized, [X2]). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JITTER_RADIUS = 12;

export interface GraphStoreOptions {
  schedule?: CommitScheduler;
  /**
   * Current position of a node on the layout axis (the controller wires
   * this to the latest epoch). Undefined → the node's stored spawn point.
   */
  positionOf?: (index: number) => { x: number; y: number } | undefined;
  /** Jitter seed (tests pin it). */
  seed?: number;
}

interface NodeAttrs {
  index: number;
  kind: GraphNodeKind;
  label: string;
  cluster: string;
  spawnX: number;
  spawnY: number;
}

interface EdgeAttrs {
  index: number;
  relations: string[];
  count: number;
  lastTs: number;
}

export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`;
export const artifactNodeId = (path: string): string => `file:${path}`;

export class GraphStore {
  /**
   * The graphology model (read-only outside the store). `UndirectedGraph` is
   * the named-class form of `Graph` + `{type:'undirected'}` — the default
   * export is a CJS namespace under NodeNext resolution and does not
   * typecheck as constructable.
   */
  readonly graph: UndirectedGraph<NodeAttrs, EdgeAttrs> = new UndirectedGraph<
    NodeAttrs,
    EdgeAttrs
  >({
    multi: false,
    allowSelfLoops: false,
  });

  private readonly schedule: CommitScheduler;
  private readonly positionOf: (index: number) => { x: number; y: number } | undefined;
  private readonly rng: () => number;
  private readonly listeners = new Set<(batch: GraphMutationBatch) => void>();
  private readonly indexToId: string[] = [];
  private queue: ContextGraphTouch[] = [];
  private cancel: (() => void) | undefined;
  /**
   * Window-armed flag, tracked SEPARATELY from `cancel`: a SYNCHRONOUS
   * scheduler flushes inside `schedule()` — before the cancel handle is even
   * assigned — so `cancel ??= …` alone would wedge every later window.
   */
  private scheduled = false;
  private commits = 0;
  private disposed = false;

  constructor(options: GraphStoreOptions = {}) {
    this.schedule = options.schedule ?? defaultCommitScheduler;
    this.positionOf = options.positionOf ?? (() => undefined);
    this.rng = mulberry32(options.seed ?? 1);
  }

  get nodeCount(): number {
    return this.graph.order;
  }

  get edgeCount(): number {
    return this.graph.size;
  }

  /** Total commits emitted (assertable: commits ≤ scheduler flushes). */
  get commitCount(): number {
    return this.commits;
  }

  /** Queued-but-uncommitted touches. */
  get pending(): number {
    return this.queue.length;
  }

  nodeByIndex(index: number): GraphNodeRecord | undefined {
    const id = this.indexToId[index];
    if (id === undefined) return undefined;
    return this.recordOf(id);
  }

  nodeById(id: string): GraphNodeRecord | undefined {
    return this.graph.hasNode(id) ? this.recordOf(id) : undefined;
  }

  private recordOf(id: string): GraphNodeRecord {
    const a = this.graph.getNodeAttributes(id);
    return {
      index: a.index,
      id,
      kind: a.kind,
      label: a.label,
      cluster: a.cluster,
      spawnX: a.spawnX,
      spawnY: a.spawnY,
    };
  }

  onBatch(listener: (batch: GraphMutationBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queue validated touches; the commit is coalesced per rAF/150 ms. */
  applyTouches(touches: readonly ContextGraphTouch[]): void {
    if (this.disposed || touches.length === 0) return;
    this.queue.push(...touches);
    if (!this.scheduled) {
      this.scheduled = true;
      const cancel = this.schedule(() => this.commit());
      // A synchronous scheduler already committed: drop the stale handle.
      if (this.scheduled) this.cancel = cancel;
    }
  }

  /** Synchronous commit (dispose, tests, bulk fixture loads). */
  commitNow(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.scheduled = false;
    this.commit();
  }

  /** Broker restart / test isolation: every projection is stale. */
  reset(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.scheduled = false;
    this.queue = [];
    this.graph.clear();
    this.indexToId.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.commitNow();
    this.disposed = true;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private jitter(): number {
    return (this.rng() - 0.5) * 2 * JITTER_RADIUS;
  }

  /** Where a node referenced by `referrerId` should spawn. */
  private spawnAt(referrerId: string | undefined): { x: number; y: number } {
    if (referrerId !== undefined && this.graph.hasNode(referrerId)) {
      const a = this.graph.getNodeAttributes(referrerId);
      const live = this.positionOf(a.index);
      const bx = live?.x ?? a.spawnX;
      const by = live?.y ?? a.spawnY;
      return { x: bx + this.jitter(), y: by + this.jitter() };
    }
    return { x: this.jitter(), y: this.jitter() };
  }

  private addNode(
    id: string,
    kind: GraphNodeKind,
    label: string,
    cluster: string,
    spawn: { x: number; y: number },
    added: GraphNodeRecord[],
  ): number {
    const index = this.indexToId.length;
    this.indexToId.push(id);
    this.graph.addNode(id, { index, kind, label, cluster, spawnX: spawn.x, spawnY: spawn.y });
    added.push({ index, id, kind, label, cluster, spawnX: spawn.x, spawnY: spawn.y });
    return index;
  }

  private commit(): void {
    this.cancel = undefined;
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];

    const addedNodes: GraphNodeRecord[] = [];
    const addedEdges: GraphEdgeRecord[] = [];
    const retagged: { index: number; kind: GraphNodeKind }[] = [];
    const pulses: number[] = [];
    const pulsed = new Set<number>();

    for (const touch of batch) {
      const sid = sessionNodeId(touch.sessionId);
      const fid = artifactNodeId(touch.path);
      const artifactExists = this.graph.hasNode(fid);

      // Session node: spawns at the artifact when one exists (the artifact
      // is then the referrer), else near the field origin.
      if (!this.graph.hasNode(sid)) {
        this.addNode(
          sid,
          'session',
          touch.sessionId,
          touch.sessionId,
          this.spawnAt(artifactExists ? fid : undefined),
          addedNodes,
        );
      }

      const touchedKind = classifyArtifact(touch.path, touch.relation);
      if (!artifactExists) {
        // Spawn AT the referrer (the session that touched it) + jitter.
        const slash = touch.path.lastIndexOf('/');
        const label = slash === -1 ? touch.path : touch.path.slice(slash + 1);
        this.addNode(
          fid,
          touchedKind,
          label,
          touch.sessionId,
          this.spawnAt(sid),
          addedNodes,
        );
      } else {
        const attrs = this.graph.getNodeAttributes(fid);
        const next = upgradeKind(attrs.kind, touchedKind);
        if (next !== attrs.kind) {
          this.graph.setNodeAttribute(fid, 'kind', next);
          retagged.push({ index: attrs.index, kind: next });
        }
        // Amber pulse: the actively-touched artifact ONLY.
        if (!pulsed.has(attrs.index)) {
          pulsed.add(attrs.index);
          pulses.push(attrs.index);
        }
      }

      if (!this.graph.hasEdge(sid, fid)) {
        const index = this.graph.size;
        this.graph.addEdge(sid, fid, {
          index,
          relations: [touch.relation],
          count: 1,
          lastTs: touch.ts,
        });
        addedEdges.push({
          index,
          sourceIndex: this.graph.getNodeAttribute(sid, 'index'),
          targetIndex: this.graph.getNodeAttribute(fid, 'index'),
        });
      } else {
        const attrs = this.graph.getEdgeAttributes(sid, fid);
        if (!attrs.relations.includes(touch.relation)) attrs.relations.push(touch.relation);
        this.graph.setEdgeAttribute(sid, fid, 'count', attrs.count + 1);
        this.graph.setEdgeAttribute(sid, fid, 'lastTs', Math.max(attrs.lastTs, touch.ts));
      }
    }

    const commit: GraphMutationBatch = {
      addedNodes,
      addedEdges,
      pulses,
      retagged,
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
    };
    this.commits += 1;
    for (const listener of [...this.listeners]) listener(commit);
  }
}
