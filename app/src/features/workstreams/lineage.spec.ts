/**
 * Lineage layout — the git-metaphor placement rules (plan §9.2 FE-6;
 * blueprint §5 semantics over the frozen §16.1 records):
 * Positive: a CONTINUATION IS A CHILD — the continue-child lands BELOW the
 *           parent on the SAME lane (never a sibling lane); forks branch.
 * Negative: an edge whose endpoint has not landed yet is skipped without
 *           throwing (bounded-journal replay reality).
 * Edge:     merge nodes place only after EVERY parent; double-resume history
 *           stays renderable (second continue-child branches); self-continue
 *           annotates in place; import roots a lane; determinism; cycles
 *           terminate.
 */

import { describe, expect, it } from 'vitest';
import { buildLineageLayout, edgesInOrder, nodesInScope } from './lineage.ts';
import { edgeEvent, nodeRecord, T0 } from './specHelpers.ts';

function rowOf(layout: ReturnType<typeof buildLineageLayout>, sessionId: string) {
  const row = layout.rows.find((r) => r.sessionId === sessionId);
  if (row === undefined) throw new Error(`row not placed: ${sessionId}`);
  return row;
}

describe('continuation is a CHILD, never a sibling', () => {
  it('a continue-child inherits the parent lane and lands below it (positive)', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_root', { createdAt: T0 }), nodeRecord('ses_next', { createdAt: T0 + 1 })],
      [edgeEvent('edg_1', 'ses_root', 'ses_next')],
    );
    const root = rowOf(layout, 'ses_root');
    const next = rowOf(layout, 'ses_next');
    expect(next.lane).toBe(root.lane); // same rail — the trunk continues
    expect(next.row).toBeGreaterThan(root.row); // child renders BELOW
    expect(next.parentSessionIds).toEqual(['ses_root']);
  });

  it('compact / handoff / workflow edges also continue the rail', () => {
    for (const edgeType of ['compact', 'handoff', 'workflow'] as const) {
      const layout = buildLineageLayout(
        [nodeRecord('ses_a', { createdAt: T0 }), nodeRecord('ses_b', { createdAt: T0 + 1 })],
        [
          edgeEvent('edg_1', 'ses_a', 'ses_b', {
            edgeType,
            ...(edgeType === 'handoff' ? { briefId: 'br_1' } : {}),
          }),
        ],
      );
      expect(rowOf(layout, 'ses_b').lane).toBe(rowOf(layout, 'ses_a').lane);
    }
  });

  it('a fork child BRANCHES to a new lane while the trunk continues', () => {
    const layout = buildLineageLayout(
      [
        nodeRecord('ses_root', { createdAt: T0 }),
        nodeRecord('ses_trunk', { createdAt: T0 + 1 }),
        nodeRecord('ses_branch', { createdAt: T0 + 2 }),
      ],
      [
        edgeEvent('edg_1', 'ses_root', 'ses_trunk'),
        edgeEvent('edg_2', 'ses_root', 'ses_branch', { edgeType: 'fork' }),
      ],
    );
    const root = rowOf(layout, 'ses_root');
    expect(rowOf(layout, 'ses_trunk').lane).toBe(root.lane);
    expect(rowOf(layout, 'ses_branch').lane).not.toBe(root.lane);
  });

  it('double-resume history: the SECOND continue-child branches (edge)', () => {
    const layout = buildLineageLayout(
      [
        nodeRecord('ses_root', { createdAt: T0 }),
        nodeRecord('ses_c1', { createdAt: T0 + 1 }),
        nodeRecord('ses_c2', { createdAt: T0 + 2 }),
      ],
      [
        edgeEvent('edg_1', 'ses_root', 'ses_c1'),
        edgeEvent('edg_2', 'ses_root', 'ses_c2'),
      ],
    );
    const root = rowOf(layout, 'ses_root');
    const first = rowOf(layout, 'ses_c1');
    const second = rowOf(layout, 'ses_c2');
    expect(first.lane).toBe(root.lane); // earliest child continues the rail
    expect(second.lane).not.toBe(root.lane); // later child branches — no collision
    expect(first.lane).not.toBe(second.lane);
  });

  it('a self continue edge (in-place resume) annotates without a new row', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_a')],
      [edgeEvent('edg_self', 'ses_a', 'ses_a')],
    );
    expect(layout.rows).toHaveLength(1);
    expect(rowOf(layout, 'ses_a').hasSelfContinue).toBe(true);
    // The edge VM degenerates to a point — the deck renders no rail sweep.
    const vm = layout.edges.find((e) => e.edgeId === 'edg_self');
    expect(vm).toBeDefined();
    expect(vm?.fromRow).toBe(vm?.toRow);
    expect(vm?.fromLane).toBe(vm?.toLane);
  });
});

describe('merge convergence', () => {
  it('a merge node places after EVERY parent with N merge_parent edges', () => {
    const layout = buildLineageLayout(
      [
        nodeRecord('ses_a', { createdAt: T0 }),
        nodeRecord('ses_b', { createdAt: T0 + 1 }),
        // The merge node is created EARLIEST by timestamp noise — placement
        // must still wait for both parents.
        nodeRecord('ses_m', { createdAt: T0 - 5 }),
      ],
      [
        edgeEvent('edg_ma', 'ses_a', 'ses_m', { edgeType: 'merge_parent' }),
        edgeEvent('edg_mb', 'ses_b', 'ses_m', { edgeType: 'merge_parent' }),
      ],
    );
    const merge = rowOf(layout, 'ses_m');
    expect(merge.isMerge).toBe(true);
    expect(merge.parentSessionIds).toEqual(['ses_a', 'ses_b']);
    expect(merge.row).toBeGreaterThan(rowOf(layout, 'ses_a').row);
    expect(merge.row).toBeGreaterThan(rowOf(layout, 'ses_b').row);
    // Converges onto the first parent's rail (it is free).
    expect(merge.lane).toBe(rowOf(layout, 'ses_a').lane);
    // Both merge edges draw to the merge node.
    const toMerge = layout.edges.filter((e) => e.edgeType === 'merge_parent');
    expect(toMerge).toHaveLength(2);
    expect(new Set(toMerge.map((e) => e.toRow)).size).toBe(1);
  });

  it('one merge_parent edge alone does not read as a merge (negative)', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_a', { createdAt: T0 }), nodeRecord('ses_m', { createdAt: T0 + 1 })],
      [edgeEvent('edg_1', 'ses_a', 'ses_m', { edgeType: 'merge_parent' })],
    );
    expect(rowOf(layout, 'ses_m').isMerge).toBe(false);
  });
});

describe('imports, orphans and replay tolerance', () => {
  it('an import edge roots a lane (no in-graph parent)', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_ext', { origin: 'reconciled', confidence: 'inferred' })],
      [edgeEvent('edg_imp', undefined, 'ses_ext', { edgeType: 'import', confidence: 'inferred' })],
    );
    const row = rowOf(layout, 'ses_ext');
    expect(row.parentSessionIds).toEqual([]);
    expect(row.row).toBe(0);
  });

  it('an edge whose node has not landed yet is skipped, not thrown (negative)', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_a')],
      [edgeEvent('edg_1', 'ses_a', 'ses_missing')],
    );
    expect(layout.rows).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    // …and once the node lands the edge participates.
    const later = buildLineageLayout(
      [nodeRecord('ses_a', { createdAt: T0 }), nodeRecord('ses_missing', { createdAt: T0 + 1 })],
      [edgeEvent('edg_1', 'ses_a', 'ses_missing')],
    );
    expect(later.edges).toHaveLength(1);
  });

  it('cyclic wire history terminates and places every node (edge)', () => {
    const layout = buildLineageLayout(
      [nodeRecord('ses_a', { createdAt: T0 }), nodeRecord('ses_b', { createdAt: T0 + 1 })],
      [
        edgeEvent('edg_ab', 'ses_a', 'ses_b'),
        edgeEvent('edg_ba', 'ses_b', 'ses_a'),
      ],
    );
    expect(layout.rows).toHaveLength(2);
  });

  it('deep chains stay on one rail; rows follow generation order', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 40; i += 1) {
      nodes.push(nodeRecord(`ses_${i}`, { createdAt: T0 + i }));
      if (i > 0) edges.push(edgeEvent(`edg_${i}`, `ses_${i - 1}`, `ses_${i}`));
    }
    const layout = buildLineageLayout(nodes, edges);
    expect(layout.rows).toHaveLength(40);
    expect(new Set(layout.rows.map((r) => r.lane)).size).toBe(1);
    for (let i = 1; i < 40; i += 1) {
      expect(rowOf(layout, `ses_${i}`).row).toBeGreaterThan(rowOf(layout, `ses_${i - 1}`).row);
    }
  });

  it('the layout is deterministic: same records in, same layout out', () => {
    const nodes = [
      nodeRecord('ses_r', { createdAt: T0 }),
      nodeRecord('ses_a', { createdAt: T0 + 1 }),
      nodeRecord('ses_b', { createdAt: T0 + 2 }),
      nodeRecord('ses_m', { createdAt: T0 + 3 }),
    ];
    const edges = [
      edgeEvent('edg_1', 'ses_r', 'ses_a'),
      edgeEvent('edg_2', 'ses_r', 'ses_b', { edgeType: 'fork' }),
      edgeEvent('edg_3', 'ses_a', 'ses_m', { edgeType: 'merge_parent' }),
      edgeEvent('edg_4', 'ses_b', 'ses_m', { edgeType: 'merge_parent' }),
    ];
    expect(buildLineageLayout(nodes, edges)).toEqual(buildLineageLayout(nodes, edges));
  });
});

describe('scope helpers', () => {
  it('nodesInScope splits workstream membership from the detached bucket', () => {
    const nodes = {
      ses_a: nodeRecord('ses_a', { workstreamId: 'ws_1' }),
      ses_b: nodeRecord('ses_b'),
    };
    expect(nodesInScope(nodes, 'ws_1').map((n) => n.sessionId)).toEqual(['ses_a']);
    expect(nodesInScope(nodes, 'detached').map((n) => n.sessionId)).toEqual(['ses_b']);
  });

  it('edgesInOrder preserves append order and skips unknown ids', () => {
    const e1 = edgeEvent('edg_1', 'ses_a', 'ses_b');
    const edges = { edg_1: e1 };
    expect(edgesInOrder(edges, ['edg_1', 'edg_ghost'])).toEqual([e1]);
  });
});
