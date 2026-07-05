/**
 * Workstream lineage store semantics (plan §9.2 FE-6; ws-protocol.md §16):
 * Positive: rail/detail snapshots project; node UPSERT on sessionId; edge
 *           APPEND on edgeId; briefs shelve; advisories arm; merges correlate.
 * Negative: replayed older snapshots/advisories never regress the view;
 *           replayed edgeIds are no-ops (edges are immutable once recorded);
 *           a §16.4 error after a resolution is stale noise and is ignored.
 * Edge:     ceremony arms on edge EVENTS only, coalesced to the newest per
 *           batch (DESIGN.md §3.3); snapshot-carried edges render settled;
 *           the brief shelf is bounded (MAX_BRIEFS, oldest evicted).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeAdvisories,
  DETACHED_SCOPE,
  MAX_BRIEFS,
  workstreamsStore,
} from './store.ts';
import {
  advisory,
  brief,
  detachedSnap,
  detailSnap,
  edgeEvent,
  listSnap,
  nodeEvent,
  nodeRecord,
  summary,
  T0,
} from './specHelpers.ts';

const store = workstreamsStore;

beforeEach(() => {
  store.getState().reset();
});

describe('rail (list snapshot)', () => {
  it('projects the latest snapshot (positive)', () => {
    store.getState().applyBatch([listSnap([summary('ws_a')], 2, T0)]);
    expect(store.getState().rail?.workstreams[0]?.workstreamId).toBe('ws_a');
    expect(store.getState().rail?.detachedNodeCount).toBe(2);
  });

  it('a replayed OLDER snapshot never regresses the rail (negative)', () => {
    store.getState().applyBatch([listSnap([summary('ws_a')], 0, T0 + 10)]);
    store.getState().applyBatch([listSnap([], 9, T0)]);
    expect(store.getState().rail?.capturedAt).toBe(T0 + 10);
    expect(store.getState().rail?.workstreams).toHaveLength(1);
  });
});

describe('detail snapshots re-baseline their scope (§16.5)', () => {
  it('drops scope members absent from the snapshot, keeps other scopes', () => {
    store.getState().applyBatch([
      nodeEvent('ses_a', { workstreamId: 'ws_a' }),
      nodeEvent('ses_gone', { workstreamId: 'ws_a' }),
      nodeEvent('ses_other', { workstreamId: 'ws_b' }),
      nodeEvent('ses_det'),
    ]);
    store
      .getState()
      .applyBatch([
        detailSnap(summary('ws_a'), [nodeRecord('ses_a', { workstreamId: 'ws_a' })], [], T0 + 1),
      ]);
    const nodes = store.getState().nodes;
    expect(nodes['ses_a']).toBeDefined();
    expect(nodes['ses_gone']).toBeUndefined(); // re-baselined away
    expect(nodes['ses_other']).toBeDefined(); // other scope untouched
    expect(nodes['ses_det']).toBeDefined(); // detached bucket untouched
  });

  it('the detached snapshot re-baselines ONLY the detached bucket', () => {
    store.getState().applyBatch([
      nodeEvent('ses_det_gone'),
      nodeEvent('ses_ws', { workstreamId: 'ws_a' }),
    ]);
    store
      .getState()
      .applyBatch([
        detachedSnap(
          [nodeRecord('ses_det_kept', { origin: 'reconciled', confidence: 'inferred' })],
          [],
          T0 + 1,
        ),
      ]);
    const nodes = store.getState().nodes;
    expect(nodes['ses_det_gone']).toBeUndefined();
    expect(nodes['ses_det_kept']).toBeDefined();
    expect(nodes['ses_ws']).toBeDefined();
  });

  it('monotone per scope: an older replayed snapshot is dropped (negative)', () => {
    store
      .getState()
      .applyBatch([
        detailSnap(summary('ws_a'), [nodeRecord('ses_new', { workstreamId: 'ws_a' })], [], T0 + 5),
      ]);
    store
      .getState()
      .applyBatch([
        detailSnap(summary('ws_a'), [nodeRecord('ses_old', { workstreamId: 'ws_a' })], [], T0),
      ]);
    expect(store.getState().nodes['ses_new']).toBeDefined();
    expect(store.getState().nodes['ses_old']).toBeUndefined();
    expect(store.getState().scopeCapturedAt['ws_a']).toBe(T0 + 5);
  });

  it('scope watermarks are independent between scopes (edge)', () => {
    store.getState().applyBatch([detachedSnap([], [], T0 + 100)]);
    store
      .getState()
      .applyBatch([
        detailSnap(summary('ws_a'), [nodeRecord('ses_a', { workstreamId: 'ws_a' })], [], T0),
      ]);
    expect(store.getState().nodes['ses_a']).toBeDefined();
    expect(store.getState().scopeCapturedAt[DETACHED_SCOPE]).toBe(T0 + 100);
  });
});

describe('node upserts + edge appends', () => {
  it('node events UPSERT on sessionId and strip the wire kind (positive)', () => {
    store.getState().applyBatch([nodeEvent('ses_a', { state: 'running' })]);
    store.getState().applyBatch([nodeEvent('ses_a', { state: 'completed' })]);
    const node = store.getState().nodes['ses_a'];
    expect(node?.state).toBe('completed');
    expect(node !== undefined && 'kind' in node).toBe(false);
    expect(Object.keys(store.getState().nodes)).toHaveLength(1);
  });

  it('edges are immutable: a replayed edgeId is a no-op (negative)', () => {
    store.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]);
    store.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_c', { edgeType: 'fork' })]);
    expect(store.getState().edges['edg_1']?.toSessionId).toBe('ses_b');
    expect(store.getState().edges['edg_1']?.edgeType).toBe('continue');
    expect(store.getState().edgeOrder).toEqual(['edg_1']);
  });

  it('edge insertion order is stable across snapshots and events (edge)', () => {
    store
      .getState()
      .applyBatch([
        detailSnap(
          summary('ws_a'),
          [nodeRecord('ses_a', { workstreamId: 'ws_a' })],
          [edgeEvent('edg_snap', 'ses_a', 'ses_a')],
        ),
      ]);
    store.getState().applyBatch([edgeEvent('edg_live', 'ses_a', 'ses_b')]);
    expect(store.getState().edgeOrder).toEqual(['edg_snap', 'edg_live']);
  });
});

describe('THE ceremony marker (DESIGN.md §3.3 — lineage events only)', () => {
  it('an edge EVENT arms ceremony; epoch is a monotone retrigger key', () => {
    store.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]);
    expect(store.getState().ceremony).toEqual({
      edgeId: 'edg_1',
      toSessionId: 'ses_b',
      epoch: 1,
    });
    store.getState().applyBatch([edgeEvent('edg_2', 'ses_b', 'ses_c', { ts: T0 + 1 })]);
    expect(store.getState().ceremony?.edgeId).toBe('edg_2');
    expect(store.getState().ceremony?.epoch).toBe(2);
  });

  it('coalesces: only the NEWEST edge event in a batch arms (edge)', () => {
    store.getState().applyBatch([
      edgeEvent('edg_1', 'ses_a', 'ses_b', { ts: T0 + 2 }),
      edgeEvent('edg_2', 'ses_b', 'ses_c', { ts: T0 + 9 }),
      edgeEvent('edg_3', 'ses_c', 'ses_d', { ts: T0 + 5 }),
    ]);
    expect(store.getState().ceremony?.edgeId).toBe('edg_2');
    expect(store.getState().ceremony?.epoch).toBe(1);
  });

  it('snapshot-carried edges NEVER arm ceremony (negative)', () => {
    store
      .getState()
      .applyBatch([
        detailSnap(
          summary('ws_a'),
          [nodeRecord('ses_a', { workstreamId: 'ws_a' })],
          [edgeEvent('edg_snap', 'ses_a', 'ses_a')],
        ),
      ]);
    expect(store.getState().ceremony).toBeUndefined();
  });

  it('nodes, briefs, advisories and merge resolutions never arm (negative)', () => {
    store.getState().applyBatch([
      nodeEvent('ses_a'),
      brief('br_1', ['ses_a']),
      advisory('ses_a'),
      { kind: 'workstream-merge-resolved', mergeId: 'mrg_1', sessionId: 'ses_m', briefId: 'br_m' },
    ]);
    expect(store.getState().ceremony).toBeUndefined();
  });

  it('a replayed (duplicate) edge does not re-arm ceremony (negative)', () => {
    store.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]);
    store.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]);
    expect(store.getState().ceremony?.epoch).toBe(1);
  });
});

describe('brief shelf', () => {
  it('shelves briefs by id, newest body wins, order tracks first arrival', () => {
    store.getState().applyBatch([brief('br_1', ['ses_a']), brief('br_2', ['ses_b'])]);
    store.getState().applyBatch([brief('br_1', ['ses_a'], { provenance: 'refined' })]);
    expect(store.getState().briefOrder).toEqual(['br_1', 'br_2']);
    expect(store.getState().briefs['br_1']?.provenance).toBe('refined');
  });

  it('is bounded: MAX_BRIEFS evicts the oldest (edge)', () => {
    const batch = [];
    for (let i = 0; i < MAX_BRIEFS + 3; i += 1) batch.push(brief(`br_${i}`, ['ses_a']));
    store.getState().applyBatch(batch);
    expect(store.getState().briefOrder).toHaveLength(MAX_BRIEFS);
    expect(store.getState().briefs['br_0']).toBeUndefined();
    expect(store.getState().briefs['br_2']).toBeUndefined();
    expect(store.getState().briefs['br_3']).toBeDefined();
  });
});

describe('branch-now advisory — an instrument state, never a toast', () => {
  it('latest advisory per session; dismissal is a ts watermark', () => {
    store.getState().applyBatch([advisory('ses_a', 71.5, T0)]);
    expect(activeAdvisories(store.getState())).toHaveLength(1);
    store.getState().dismissAdvisory('ses_a');
    expect(activeAdvisories(store.getState())).toHaveLength(0);
    // The same reading never re-spams…
    store.getState().applyBatch([advisory('ses_a', 71.5, T0)]);
    expect(activeAdvisories(store.getState())).toHaveLength(0);
    // …but a NEWER reading re-arms the instrument.
    store.getState().applyBatch([advisory('ses_a', 84, T0 + 60_000)]);
    expect(activeAdvisories(store.getState())).toHaveLength(1);
    expect(activeAdvisories(store.getState())[0]?.contextUsedPct).toBe(84);
  });

  it('a replayed older advisory never resurfaces (negative)', () => {
    store.getState().applyBatch([advisory('ses_a', 90, T0 + 100)]);
    store.getState().applyBatch([advisory('ses_a', 70, T0)]);
    expect(store.getState().advisories['ses_a']?.contextUsedPct).toBe(90);
  });

  it('dismissing a session with no advisory is a no-op (edge)', () => {
    const before = store.getState().advisoryDismissedAt;
    store.getState().dismissAdvisory('ses_none');
    expect(store.getState().advisoryDismissedAt).toBe(before);
  });
});

describe('merge correlation (§16.2–§16.4)', () => {
  it('pending → resolved keeps the dispatch-time parent selection', () => {
    store.getState().trackMerge({ mergeId: 'mrg_1', phase: 'pending', parents: ['ses_a', 'ses_b'] });
    store
      .getState()
      .applyBatch([
        { kind: 'workstream-merge-resolved', mergeId: 'mrg_1', sessionId: 'ses_m', briefId: 'br_m' },
      ]);
    expect(store.getState().merges['mrg_1']).toEqual({
      mergeId: 'mrg_1',
      phase: 'resolved',
      sessionId: 'ses_m',
      briefId: 'br_m',
      parents: ['ses_a', 'ses_b'],
    });
  });

  it('pending → failed with the frozen §16.4 code', () => {
    store.getState().trackMerge({ mergeId: 'mrg_1', phase: 'pending', parents: ['ses_a', 'ses_b'] });
    store.getState().applyMergeError('mrg_1', 'session-not-found');
    expect(store.getState().merges['mrg_1']?.phase).toBe('failed');
    expect(store.getState().merges['mrg_1']?.code).toBe('session-not-found');
  });

  it('an error after a resolution is stale replay noise — ignored (negative)', () => {
    store
      .getState()
      .applyBatch([
        { kind: 'workstream-merge-resolved', mergeId: 'mrg_1', sessionId: 'ses_m', briefId: 'br_m' },
      ]);
    store.getState().applyMergeError('mrg_1', 'internal');
    expect(store.getState().merges['mrg_1']?.phase).toBe('resolved');
  });

  it('a resolution for an untracked mergeId still lands (another window decided)', () => {
    store
      .getState()
      .applyBatch([
        { kind: 'workstream-merge-resolved', mergeId: 'mrg_x', sessionId: 'ses_m', briefId: 'br_m' },
      ]);
    expect(store.getState().merges['mrg_x']?.phase).toBe('resolved');
  });
});

describe('reset', () => {
  it('clears every projection (broker restart path)', () => {
    store.getState().applyBatch([
      listSnap([summary('ws_a')]),
      nodeEvent('ses_a'),
      edgeEvent('edg_1', 'ses_a', 'ses_b'),
      brief('br_1', ['ses_a']),
      advisory('ses_a'),
    ]);
    store.getState().reset();
    const s = store.getState();
    expect(s.rail).toBeUndefined();
    expect(s.nodes).toEqual({});
    expect(s.edges).toEqual({});
    expect(s.edgeOrder).toEqual([]);
    expect(s.briefs).toEqual({});
    expect(s.advisories).toEqual({});
    expect(s.merges).toEqual({});
    expect(s.ceremony).toBeUndefined();
  });
});
