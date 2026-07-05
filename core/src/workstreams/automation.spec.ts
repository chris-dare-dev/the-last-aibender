/**
 * [X4] brief automation (hooks-contract.md §7.1; plan §9.2 BE-7 positive row
 * "brief generated on SessionEnd"; frozen idempotence: same session_id +
 * event → ONE brief). Accepted posts are built through the REAL frozen
 * validator (validateHookPost) so the handler sees exactly what BE-5's
 * endpoint hands it.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { validateHookPost, type AcceptedHookPost } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import type { WorkstreamServerPayload } from '@aibender/protocol';

import { createWorkstreamHookAutomation } from './automation.js';
import { NATIVE_COMPACTION_SUMMARY_PREFIX } from './briefs.js';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function accepted(body: Record<string, unknown>): AcceptedHookPost {
  const outcome = validateHookPost('MAX_A', body);
  if (!outcome.ok) throw new Error('fixture body must validate');
  return outcome.accepted;
}

async function harness(options: { readTranscript?: (path: string) => string | undefined } = {}) {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  let br = 0;
  let edg = 0;
  let snap = 0;
  const automation = createWorkstreamHookAutomation({
    store: store.lineage,
    publish: (payload) => published.push(payload),
    ...(options.readTranscript !== undefined ? { readTranscript: options.readTranscript } : {}),
    nowMs: () => 90_200_000,
    newBriefId: () => `br_auto${String(br++).padStart(2, '0')}`,
    newEdgeId: () => `edg_auto${String(edg++).padStart(2, '0')}`,
    newSnapshotNodeId: () => `ses_snap${String(snap++).padStart(2, '0')}`,
  });
  const insertNode = (id: string, nativeSessionId: string, workstreamId?: string): void => {
    if (workstreamId !== undefined && store.lineage.workstreams.get(workstreamId) === undefined) {
      store.lineage.workstreams.insert({ id: workstreamId, title: `stream ${workstreamId}` });
    }
    store.lineage.nodes.insert({
      id,
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      backend: 'claude_code',
      account: 'MAX_A',
      nativeSessionId,
      cwd: '/synthetic/workspace',
      state: 'running',
      origin: 'harness',
      confidence: 'recorded',
    });
  };
  return { store, automation, published, insertNode };
}

describe('onSessionEnd (the auto continuation brief)', () => {
  it('produces ONE session-end brief, settles the lineage state, publishes brief + node', async () => {
    const { store, automation, published, insertNode } = await harness();
    insertNode('ses_live', 'native-001');

    automation.onSessionEnd(accepted({ hook_event_name: 'SessionEnd', session_id: 'native-001' }));
    await automation.settle();

    const briefs = store.lineage.briefs.list({ kinds: ['session-end'] });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.sourceNodes).toEqual(['ses_live']);
    expect(store.lineage.nodes.get('ses_live')?.state).toBe('completed');
    expect(published.some((payload) => payload.kind === 'workstream-brief')).toBe(true);
    expect(automation.stats()).toMatchObject({ briefsCreated: 1, failures: 0 });
  });

  it('IDEMPOTENT: duplicate posts of the same (event, session) produce ONE brief', async () => {
    const { store, automation, insertNode } = await harness();
    insertNode('ses_live', 'native-001');
    const post = accepted({ hook_event_name: 'SessionEnd', session_id: 'native-001' });

    automation.onSessionEnd(post);
    automation.onSessionEnd(post);
    automation.onSessionEnd(post);
    await automation.settle();

    expect(store.lineage.briefs.list({ kinds: ['session-end'] })).toHaveLength(1);
    expect(automation.stats().duplicatesSuppressed).toBe(2);
  });

  it('unknown native id is SKIPPED without burning the dedupe key (reconciler-then-retry works)', async () => {
    const { store, automation, insertNode } = await harness();
    const post = accepted({ hook_event_name: 'SessionEnd', session_id: 'native-late' });

    automation.onSessionEnd(post); // node not registered yet → skip
    await automation.settle();
    expect(store.lineage.briefs.list()).toHaveLength(0);
    expect(automation.stats().unknownSessionsSkipped).toBe(1);

    insertNode('ses_late', 'native-late'); // the reconciler registered it
    automation.onSessionEnd(post); // the retried post now produces its brief
    await automation.settle();
    expect(store.lineage.briefs.list({ kinds: ['session-end'] })).toHaveLength(1);
  });

  it('REUSES the native compaction summary when the transcript carries one', async () => {
    const summary = `${NATIVE_COMPACTION_SUMMARY_PREFIX} with prior context.`;
    const transcript = JSON.stringify({ type: 'user', message: { content: summary } });
    const { store, automation, insertNode } = await harness({
      readTranscript: () => transcript,
    });
    insertNode('ses_live', 'native-001');
    automation.onSessionEnd(
      accepted({
        hook_event_name: 'SessionEnd',
        session_id: 'native-001',
        transcript_path: '/synthetic/tree/native-001.jsonl',
      }),
    );
    await automation.settle();
    const brief = store.lineage.briefs.list()[0];
    expect(brief?.provenance).toBe('native-summary');
    expect(brief?.bodyMd).toBe(summary);
  });
});

describe('onPreCompact (snapshot brief + compact edge)', () => {
  it('records the pre-compact brief, the snapshot node, and the compact edge INTO the live node', async () => {
    const { store, automation, published, insertNode } = await harness();
    insertNode('ses_live', 'native-001', 'ws_01');

    automation.onPreCompact(
      accepted({
        hook_event_name: 'PreCompact',
        session_id: 'native-001',
        trigger: 'auto',
        transcript_path: '/synthetic/tree/native-001.jsonl',
      }),
    );
    await automation.settle();

    const briefs = store.lineage.briefs.list({ kinds: ['pre-compact'] });
    expect(briefs).toHaveLength(1);

    const snapshot = store.lineage.nodes.get('ses_snap00');
    expect(snapshot).toMatchObject({
      workstreamId: 'ws_01',
      state: 'completed',
      origin: 'harness',
      nativeSessionId: null, // resolution stays on the live node
      transcriptRef: '/synthetic/tree/native-001.jsonl',
    });

    const edges = store.lineage.edges.list({ edgeTypes: ['compact'] });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromNode: 'ses_snap00', toNode: 'ses_live' });
    expect(JSON.parse(edges[0]?.metadataJson ?? '{}')).toMatchObject({
      reason: 'pre-compact',
      trigger: 'auto',
    });

    // The live node keeps its native-id resolution (oldest-first lookup).
    expect(store.lineage.nodes.byNativeSessionId('native-001')?.id).toBe('ses_live');
    expect(published.filter((payload) => payload.kind === 'workstream-edge')).toHaveLength(1);
    expect(automation.stats().compactEdgesRecorded).toBe(1);
  });

  it('duplicate PreCompact posts record ONE snapshot + edge', async () => {
    const { store, automation, insertNode } = await harness();
    insertNode('ses_live', 'native-001');
    const post = accepted({ hook_event_name: 'PreCompact', session_id: 'native-001' });
    automation.onPreCompact(post);
    automation.onPreCompact(post);
    await automation.settle();
    expect(store.lineage.edges.list({ edgeTypes: ['compact'] })).toHaveLength(1);
  });
});

describe('onSessionStart (brief injection, the frozen response shape)', () => {
  it('injects the workstream LATEST brief on resume; never on startup', async () => {
    const { store, automation, insertNode } = await harness();
    insertNode('ses_a', 'native-a', 'ws_01');
    insertNode('ses_b', 'native-b', 'ws_01');
    store.lineage.briefs.insert({
      id: 'br_00older',
      kind: 'session-end',
      bodyMd: 'older brief for /synthetic/workspace',
      sourceNodes: ['ses_a'],
      provenance: 'local-draft',
    });
    store.lineage.briefs.insert({
      id: 'br_01latest',
      kind: 'pre-compact',
      bodyMd: 'latest brief for /synthetic/workspace',
      sourceNodes: ['ses_b'],
      provenance: 'native-summary',
    });

    const startup = automation.onSessionStart(
      accepted({ hook_event_name: 'SessionStart', session_id: 'native-a', source: 'startup' }),
    );
    expect(startup).toBeUndefined();

    const resume = automation.onSessionStart(
      accepted({ hook_event_name: 'SessionStart', session_id: 'native-a', source: 'resume' }),
    );
    expect(resume?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(resume?.hookSpecificOutput.additionalContext).toContain('latest brief');
    await automation.settle();

    // The injection is RECORDED once as a session-start-injection brief.
    expect(store.lineage.briefs.list({ kinds: ['session-start-injection'] })).toHaveLength(1);
  });

  it('unknown session / no brief available → undefined (no injection)', async () => {
    const { automation, insertNode } = await harness();
    expect(
      automation.onSessionStart(
        accepted({ hook_event_name: 'SessionStart', session_id: 'native-x', source: 'resume' }),
      ),
    ).toBeUndefined();
    insertNode('ses_briefless', 'native-briefless');
    expect(
      automation.onSessionStart(
        accepted({ hook_event_name: 'SessionStart', session_id: 'native-briefless', source: 'resume' }),
      ),
    ).toBeUndefined();
  });

  it('detached node scopes injection to its OWN briefs', async () => {
    const { store, automation, insertNode } = await harness();
    insertNode('ses_detached', 'native-d');
    insertNode('ses_other', 'native-o', 'ws_09');
    store.lineage.briefs.insert({
      id: 'br_other',
      kind: 'session-end',
      bodyMd: 'someone else brief',
      sourceNodes: ['ses_other'],
      provenance: 'local-draft',
    });
    // No brief sourced from ses_detached → no injection.
    expect(
      automation.onSessionStart(
        accepted({ hook_event_name: 'SessionStart', session_id: 'native-d', source: 'resume' }),
      ),
    ).toBeUndefined();
  });
});
