/**
 * FE-6 lineage layout — pure, deterministic assembly of the git-metaphor view
 * from frozen wire records (ws-protocol.md §16.1; blueprint §5 semantics):
 *
 *   - a CONTINUATION IS A CHILD, never a sibling: a `continue` (or `compact`
 *     / `handoff` / `workflow`) edge places its target BELOW the parent on
 *     the SAME rail — the parent's lane continues downward into the child
 *     (the git-graph trunk rule). A sibling rendering (a parallel branch
 *     lane) is exactly the failure this layout is specified against;
 *   - `fork` and `sidechain` edges BRANCH: the child opens a new lane;
 *   - a parent's lane can be continued by exactly ONE child (the earliest
 *     placed); later continue-children branch — double-resume history stays
 *     renderable without lane collisions;
 *   - a self `continue` edge (in-place resume, from === to) annotates the
 *     node without moving it (there is no new node);
 *   - `import` edges have no in-graph parent — their target roots a lane;
 *   - a MERGE node (N `merge_parent` edges) converges: it inherits its first
 *     parent's lane where free, and places only after EVERY parent is placed;
 *   - unknown endpoints are tolerated: an edge may replay before its node
 *     upsert (bounded-journal reality) — the layout skips it until the node
 *     lands; the store keeps the edge.
 *
 * Pure functions only: same records in, same layout out (the spec suite's
 * contract device). Geometry is expressed in ROW/LANE indices; the view maps
 * rows onto the --ig-grid-row rhythm and lanes onto the character grid.
 */

import type {
  LineageConfidence,
  SessionEdgeType,
  WorkstreamEdgeRecord,
  WorkstreamNodeRecord,
} from '@aibender/protocol';

export interface LineageRowVM {
  readonly sessionId: string;
  readonly node: WorkstreamNodeRecord;
  /** Rail lane — inherited from the parent for continuations, new for branches. */
  readonly lane: number;
  /** Render row index, 0-based top-down (children always after parents). */
  readonly row: number;
  /** Parent session ids in edge order (empty for roots/imports). */
  readonly parentSessionIds: readonly string[];
  /** ≥2 merge_parent edges land on this node. */
  readonly isMerge: boolean;
  /** An in-place resume (self continue edge) touched this node. */
  readonly hasSelfContinue: boolean;
}

export interface LineageEdgeVM {
  readonly edgeId: string;
  readonly edgeType: SessionEdgeType;
  readonly confidence: LineageConfidence;
  readonly fromRow: number;
  readonly fromLane: number;
  readonly toRow: number;
  readonly toLane: number;
  readonly briefId?: string;
}

export interface LineageLayout {
  readonly rows: readonly LineageRowVM[];
  readonly edges: readonly LineageEdgeVM[];
}

/** Edge types whose child continues the parent's rail (child-not-sibling). */
const INHERIT_TYPES: readonly SessionEdgeType[] = ['continue', 'compact', 'handoff', 'workflow'];

interface ParentLink {
  readonly parent: string;
  readonly edge: WorkstreamEdgeRecord;
}

function byCreation(a: WorkstreamNodeRecord, b: WorkstreamNodeRecord): number {
  return a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId);
}

/**
 * Build the layout for one scope's records. `nodes` is the scope membership;
 * `edges` may be the global append log — edges whose endpoints are not both
 * members are ignored here (cross-scope edges belong to neither panel).
 */
export function buildLineageLayout(
  nodes: readonly WorkstreamNodeRecord[],
  edges: readonly WorkstreamEdgeRecord[],
): LineageLayout {
  const nodeById = new Map<string, WorkstreamNodeRecord>();
  for (const node of nodes) nodeById.set(node.sessionId, node);

  const parents = new Map<string, ParentLink[]>();
  const children = new Map<string, string[]>();
  const selfContinue = new Set<string>();
  const layoutEdges: WorkstreamEdgeRecord[] = [];

  for (const edge of edges) {
    if (!nodeById.has(edge.toSessionId)) continue;
    if (edge.fromSessionId === undefined) {
      // `import`: no in-graph parent — the target roots a lane.
      layoutEdges.push(edge);
      continue;
    }
    if (!nodeById.has(edge.fromSessionId)) continue;
    if (edge.fromSessionId === edge.toSessionId) {
      selfContinue.add(edge.toSessionId);
      layoutEdges.push(edge);
      continue;
    }
    const list = parents.get(edge.toSessionId) ?? [];
    list.push({ parent: edge.fromSessionId, edge });
    parents.set(edge.toSessionId, list);
    const kids = children.get(edge.fromSessionId) ?? [];
    if (!kids.includes(edge.toSessionId)) kids.push(edge.toSessionId);
    children.set(edge.fromSessionId, kids);
    layoutEdges.push(edge);
  }

  // ---- placement ------------------------------------------------------------
  // Deterministic DFS pre-order from roots (creation order); a node places
  // only once EVERY parent is placed (merge nodes wait for all parents), so
  // children always land after their parents. Cycle leftovers (illegal but
  // tolerated wire history) fall back to creation order — always terminates.
  const lane = new Map<string, number>();
  const laneContinuedBy = new Map<string, string>(); // parent -> continuing child
  const order: string[] = [];
  const placed = new Set<string>();
  let nextLane = 0;

  function assignLane(sessionId: string, links: readonly ParentLink[]): number {
    // Prefer continuing the first inheritable parent whose rail is still free.
    for (const link of links) {
      const inheritable =
        INHERIT_TYPES.includes(link.edge.edgeType) || link.edge.edgeType === 'merge_parent';
      if (!inheritable) continue;
      const parentLane = lane.get(link.parent);
      if (parentLane === undefined) continue;
      if (laneContinuedBy.get(link.parent) === undefined) {
        laneContinuedBy.set(link.parent, sessionId);
        return parentLane;
      }
    }
    const fresh = nextLane;
    nextLane += 1;
    return fresh;
  }

  function tryPlace(sessionId: string): boolean {
    if (placed.has(sessionId)) return false;
    const links = parents.get(sessionId) ?? [];
    for (const link of links) {
      if (!placed.has(link.parent)) return false; // wait for every parent
    }
    lane.set(sessionId, assignLane(sessionId, links));
    placed.add(sessionId);
    order.push(sessionId);
    return true;
  }

  function descend(sessionId: string): void {
    const kids = (children.get(sessionId) ?? [])
      .map((id) => nodeById.get(id))
      .filter((n): n is WorkstreamNodeRecord => n !== undefined)
      .sort(byCreation)
      .map((n) => n.sessionId);
    for (const kid of kids) {
      if (tryPlace(kid)) descend(kid);
    }
  }

  const roots = nodes
    .filter((n) => (parents.get(n.sessionId) ?? []).length === 0)
    .sort(byCreation)
    .map((n) => n.sessionId);
  for (const root of roots) {
    if (tryPlace(root)) descend(root);
  }
  // Merge nodes first reached before their last parent placed: sweep to
  // fixpoint, then force-place any cycle leftovers in creation order.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of [...nodes].sort(byCreation)) {
      if (tryPlace(node.sessionId)) {
        descend(node.sessionId);
        progressed = true;
      }
    }
  }
  for (const node of [...nodes].sort(byCreation)) {
    if (placed.has(node.sessionId)) continue;
    const links = (parents.get(node.sessionId) ?? []).filter((l) => lane.get(l.parent) !== undefined);
    lane.set(node.sessionId, assignLane(node.sessionId, links));
    placed.add(node.sessionId);
    order.push(node.sessionId);
  }

  // ---- view models -----------------------------------------------------------
  const rowOf = new Map<string, number>();
  const rows: LineageRowVM[] = order.map((sessionId, row) => {
    rowOf.set(sessionId, row);
    const node = nodeById.get(sessionId) as WorkstreamNodeRecord;
    const links = parents.get(sessionId) ?? [];
    return {
      sessionId,
      node,
      lane: lane.get(sessionId) ?? 0,
      row,
      parentSessionIds: links.map((l) => l.parent),
      isMerge: links.filter((l) => l.edge.edgeType === 'merge_parent').length >= 2,
      hasSelfContinue: selfContinue.has(sessionId),
    };
  });

  const edgeVMs: LineageEdgeVM[] = [];
  for (const edge of layoutEdges) {
    const toRow = rowOf.get(edge.toSessionId);
    if (toRow === undefined) continue;
    const fromId = edge.fromSessionId ?? edge.toSessionId;
    const fromRow = rowOf.get(fromId);
    if (fromRow === undefined) continue;
    edgeVMs.push({
      edgeId: edge.edgeId,
      edgeType: edge.edgeType,
      confidence: edge.confidence,
      fromRow,
      fromLane: lane.get(fromId) ?? 0,
      toRow,
      toLane: lane.get(edge.toSessionId) ?? 0,
      ...(edge.briefId !== undefined ? { briefId: edge.briefId } : {}),
    });
  }

  return { rows, edges: edgeVMs };
}

/** Scope membership: one workstream's nodes, or the detached-HEAD bucket. */
export function nodesInScope(
  nodes: Readonly<Record<string, WorkstreamNodeRecord>>,
  scope: string,
): readonly WorkstreamNodeRecord[] {
  const all = Object.values(nodes);
  return scope === 'detached'
    ? all.filter((n) => n.workstreamId === undefined)
    : all.filter((n) => n.workstreamId === scope);
}

/** Edges in stable append order (the store keeps insertion order). */
export function edgesInOrder(
  edges: Readonly<Record<string, WorkstreamEdgeRecord>>,
  edgeOrder: readonly string[],
): readonly WorkstreamEdgeRecord[] {
  const out: WorkstreamEdgeRecord[] = [];
  for (const edgeId of edgeOrder) {
    const edge = edges[edgeId];
    if (edge !== undefined) out.push(edge);
  }
  return out;
}
