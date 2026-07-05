/**
 * M4 freeze surfaces: the `workstream` channel payload unions (server +
 * client), the lineage vocabularies, the LineageRecorder / SessionIdResolver
 * seams, and the hooks [X4] automation routing slice. Positive / negative /
 * edge per plan §9.2 (the BE-ORCH contract-package bar).
 */

import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  MERGE_MAX_PARENTS,
  MERGE_MIN_PARENTS,
  SESSION_EDGE_TYPES,
  X4_AUTOMATION_HOOK_EVENTS,
  ackForSessionStart,
  isReplayableChannel,
  noopLineageRecorder,
  validateHookPost,
  validateWorkstreamClientMessage,
  validateWorkstreamServerPayload,
  x4AutomationRouteFor,
  type HookSessionStartOutput,
  type LineageAction,
  type LineageRecorder,
  type SessionIdResolver,
  type WorkstreamMergeRequest,
} from './index.js';

// ---------------------------------------------------------------------------
// Shared fixtures (synthesized, [X2] fixture policy)
// ---------------------------------------------------------------------------

const NODE = {
  kind: 'workstream-node',
  sessionId: 'ses_fake_1',
  workstreamId: 'ws_fake_1',
  backend: 'claude_code',
  account: 'MAX_A',
  state: 'running',
  origin: 'harness',
  confidence: 'recorded',
  displayName: 'golden node',
  cwd: '/synthetic/workspace',
  gitBranch: 'main',
  tokensIn: 1200,
  tokensOut: 340,
  costEstimatedUsd: 0.02,
  createdAt: 90_100_000,
  lastActiveAt: 90_200_000,
} as const;

const EDGE = {
  kind: 'workstream-edge',
  edgeId: 'edg_fake_1',
  fromSessionId: 'ses_fake_1',
  toSessionId: 'ses_fake_2',
  edgeType: 'continue',
  confidence: 'recorded',
  ts: 90_300_000,
} as const;

const SUMMARY = {
  workstreamId: 'ws_fake_1',
  title: 'golden workstream',
  status: 'active',
  tags: ['golden'],
  nodeCount: 2,
  updatedAt: 90_300_000,
} as const;

const MERGE: WorkstreamMergeRequest = {
  kind: 'workstream-merge-request',
  mergeId: 'mrg_01',
  params: {
    parents: ['ses_fake_1', 'ses_fake_2'],
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    cwd: '/synthetic/workspace',
    purpose: 'golden merge',
    briefBody: '## merge brief\n\nshared goal; conflicts surfaced explicitly.',
    workstreamId: 'ws_fake_1',
  },
};

describe('workstream server payload validator (FROZEN-M4)', () => {
  // -- positive ---------------------------------------------------------------

  it('accepts every registered kind', () => {
    const payloads: unknown[] = [
      {
        kind: 'workstream-list-snapshot',
        capturedAt: 90_000_000,
        workstreams: [SUMMARY],
        detachedNodeCount: 1,
      },
      {
        kind: 'workstream-detail-snapshot',
        capturedAt: 90_000_000,
        scope: 'workstream',
        workstream: SUMMARY,
        nodes: [NODE],
        edges: [EDGE],
      },
      NODE,
      EDGE,
      {
        kind: 'workstream-brief',
        briefId: 'br_fake_1',
        briefKind: 'session-end',
        body: 'continuation brief for /synthetic/workspace (ses_fake_1)',
        sourceSessionIds: ['ses_fake_1'],
        provenance: 'native-summary',
        createdAt: 90_400_000,
        workstreamId: 'ws_fake_1',
      },
      { kind: 'branch-advisory', sessionId: 'ses_fake_1', contextUsedPct: 71.5, ts: 90_500_000 },
      {
        kind: 'workstream-merge-resolved',
        mergeId: 'mrg_01',
        sessionId: 'ses_fake_3',
        briefId: 'br_fake_2',
      },
    ];
    for (const payload of payloads) {
      const result = validateWorkstreamServerPayload(payload);
      expect(result.ok, JSON.stringify(payload)).toBe(true);
    }
  });

  it('sanitizes to contract keys (unknown keys never echo)', () => {
    const result = validateWorkstreamServerPayload({ ...NODE, extra: 'dropped' });
    expect(result.ok).toBe(true);
    if (result.ok) expect('extra' in result.value).toBe(false);
  });

  it('detail snapshot for the detached-HEAD bucket carries NO workstream summary', () => {
    const result = validateWorkstreamServerPayload({
      kind: 'workstream-detail-snapshot',
      capturedAt: 1,
      scope: 'detached',
      nodes: [{ ...NODE, workstreamId: undefined, origin: 'reconciled', confidence: 'inferred', state: 'external' }],
      edges: [],
    });
    expect(result.ok).toBe(true);
  });

  it('tolerates unknown kinds as opaque (the frozen forward-tolerant reader rule)', () => {
    const result = validateWorkstreamServerPayload({ kind: 'm5-pipeline-lens', lens: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'm5-pipeline-lens', opaque: true });
  });

  // -- negative ---------------------------------------------------------------

  it('rejects kindless payloads (tolerance requires a non-empty string kind)', () => {
    for (const bad of [{}, { kind: '' }, { kind: 42 }, null, 'text']) {
      const result = validateWorkstreamServerPayload(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('bad-request');
    }
  });

  it('rejects nodes carrying native session ids ([X2] — store attribute only)', () => {
    const result = validateWorkstreamServerPayload({ ...NODE, nativeSessionId: 'fake-native-0' });
    expect(result.ok).toBe(false);
  });

  it('rejects label/backend pairing violations on nodes', () => {
    const result = validateWorkstreamServerPayload({ ...NODE, account: 'AWS_DEV' });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown node states / origins / confidences and edge types', () => {
    expect(validateWorkstreamServerPayload({ ...NODE, state: 'spawning' }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...NODE, origin: 'native' }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...NODE, confidence: 'sure' }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...EDGE, edgeType: 'rebase' }).ok).toBe(false);
  });

  it('enforces the edge from/import matrix and the handoff-brief mandate', () => {
    // non-import without from: rejected.
    const { fromSessionId: _dropped, ...noFrom } = EDGE;
    expect(validateWorkstreamServerPayload(noFrom).ok).toBe(false);
    // import WITH from: rejected.
    expect(validateWorkstreamServerPayload({ ...EDGE, edgeType: 'import' }).ok).toBe(false);
    // import without from: valid.
    expect(validateWorkstreamServerPayload({ ...noFrom, edgeType: 'import' }).ok).toBe(true);
    // handoff without brief: rejected (context travels by brief, blueprint §5).
    expect(validateWorkstreamServerPayload({ ...EDGE, edgeType: 'handoff' }).ok).toBe(false);
    expect(
      validateWorkstreamServerPayload({ ...EDGE, edgeType: 'handoff', briefId: 'br_fake_1' }).ok,
    ).toBe(true);
  });

  it('rejects detail-snapshot scope matrix violations', () => {
    const base = { kind: 'workstream-detail-snapshot', capturedAt: 1, nodes: [], edges: [] };
    expect(validateWorkstreamServerPayload({ ...base, scope: 'workstream' }).ok).toBe(false);
    expect(
      validateWorkstreamServerPayload({ ...base, scope: 'detached', workstream: SUMMARY }).ok,
    ).toBe(false);
    expect(validateWorkstreamServerPayload({ ...base, scope: 'everything' }).ok).toBe(false);
  });

  it('rejects briefs with empty bodies or empty source sets', () => {
    const brief = {
      kind: 'workstream-brief',
      briefId: 'br_fake_1',
      briefKind: 'merge',
      body: 'b',
      sourceSessionIds: ['ses_fake_1'],
      provenance: 'refined',
      createdAt: 1,
    };
    expect(validateWorkstreamServerPayload({ ...brief, body: '' }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...brief, sourceSessionIds: [] }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...brief, briefKind: 'handoff-doc' }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...brief, provenance: 'gpt' }).ok).toBe(false);
  });

  // -- edge ---------------------------------------------------------------------

  it('branch advisory honesty pin: contextUsedPct is 0..100 inclusive', () => {
    const ok = { kind: 'branch-advisory', sessionId: 'ses_fake_1', contextUsedPct: 100, ts: 1 };
    expect(validateWorkstreamServerPayload(ok).ok).toBe(true);
    expect(validateWorkstreamServerPayload({ ...ok, contextUsedPct: 100.1 }).ok).toBe(false);
    expect(validateWorkstreamServerPayload({ ...ok, contextUsedPct: -1 }).ok).toBe(false);
  });

  it('same-node continue edges are legal (in-place resume: from === to)', () => {
    const result = validateWorkstreamServerPayload({
      ...EDGE,
      fromSessionId: 'ses_fake_1',
      toSessionId: 'ses_fake_1',
    });
    expect(result.ok).toBe(true);
  });
});

describe('workstream client message validator (the merge request, FROZEN-M4)', () => {
  // -- positive ---------------------------------------------------------------

  it('accepts a well-formed merge request and sanitizes it', () => {
    const result = validateWorkstreamClientMessage({ ...MERGE, extra: 'dropped' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(MERGE);
      expect('extra' in result.value).toBe(false);
    }
  });

  it('accepts the parent-count bounds inclusively', () => {
    const parents = Array.from({ length: MERGE_MAX_PARENTS }, (_, i) => `ses_fake_${i}`);
    const result = validateWorkstreamClientMessage({
      ...MERGE,
      params: { ...MERGE.params, parents },
    });
    expect(result.ok).toBe(true);
    expect(MERGE_MIN_PARENTS).toBe(2);
  });

  // -- negative ---------------------------------------------------------------

  it('rejects unknown client kinds (clients send workstream-merge-request only)', () => {
    const result = validateWorkstreamClientMessage({ ...NODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad-request');
  });

  it('rejects malformed mergeIds', () => {
    expect(validateWorkstreamClientMessage({ ...MERGE, mergeId: '' }).ok).toBe(false);
    expect(validateWorkstreamClientMessage({ ...MERGE, mergeId: 'has space' }).ok).toBe(false);
  });

  it('rejects too few, too many, duplicate, and malformed parents', () => {
    const withParents = (parents: unknown): unknown => ({
      ...MERGE,
      params: { ...MERGE.params, parents },
    });
    expect(validateWorkstreamClientMessage(withParents(['ses_fake_1'])).ok).toBe(false);
    expect(
      validateWorkstreamClientMessage(
        withParents(Array.from({ length: MERGE_MAX_PARENTS + 1 }, (_, i) => `ses_${i}`)),
      ).ok,
    ).toBe(false);
    expect(
      validateWorkstreamClientMessage(withParents(['ses_fake_1', 'ses_fake_1'])).ok,
    ).toBe(false);
    expect(validateWorkstreamClientMessage(withParents(['ses_fake_1', 'bad id'])).ok).toBe(false);
  });

  it('rejects pairing violations, relative cwd, blank purpose/briefBody', () => {
    const withParams = (patch: Record<string, unknown>): unknown => ({
      ...MERGE,
      params: { ...MERGE.params, ...patch },
    });
    expect(validateWorkstreamClientMessage(withParams({ backend: 'opencode' })).ok).toBe(false);
    expect(validateWorkstreamClientMessage(withParams({ cwd: 'relative/path' })).ok).toBe(false);
    expect(validateWorkstreamClientMessage(withParams({ purpose: '' })).ok).toBe(false);
    expect(validateWorkstreamClientMessage(withParams({ briefBody: '' })).ok).toBe(false);
    expect(validateWorkstreamClientMessage(withParams({ workstreamId: 'bad id' })).ok).toBe(false);
  });

  // -- edge ---------------------------------------------------------------------

  it('the merge error-code registry carries workstream-not-found', () => {
    expect(ERROR_CODES).toContain('workstream-not-found');
  });

  it('the workstream channel participates in JSON reconnect-replay', () => {
    expect(isReplayableChannel('workstream')).toBe(true);
  });
});

describe('lineage seams (LineageRecorder + SessionIdResolver, FROZEN-M4)', () => {
  // -- positive ---------------------------------------------------------------

  it('a recording fake receives every action kind (the frozen union is implementable)', () => {
    const seen: LineageAction[] = [];
    const recorder: LineageRecorder = { record: (action) => void seen.push(action) };
    const actions: LineageAction[] = [
      {
        kind: 'launch',
        sessionId: 'ses_fake_1',
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        cwd: '/synthetic/workspace',
        workstreamHint: 'ws_fake_1',
        atEpochMs: 1,
      },
      { kind: 'resume', fromSessionId: 'ses_fake_1', toSessionId: 'ses_fake_1', atEpochMs: 2 },
      { kind: 'fork', fromSessionId: 'ses_fake_1', toSessionId: 'ses_fake_2', atEpochMs: 3 },
      {
        kind: 'recycle',
        fromSessionId: 'ses_fake_2',
        toSessionId: 'ses_fake_2',
        checkpointRef: '/synthetic/checkpoint.json',
        atEpochMs: 4,
      },
      {
        kind: 'merge',
        parentSessionIds: ['ses_fake_1', 'ses_fake_2'],
        toSessionId: 'ses_fake_3',
        briefId: 'br_fake_2',
        atEpochMs: 5,
      },
    ];
    for (const action of actions) recorder.record(action);
    expect(seen.map((a) => a.kind)).toEqual(['launch', 'resume', 'fork', 'recycle', 'merge']);
  });

  it('the noop recorder is the frozen M1–M3 default (never throws, records nothing)', () => {
    expect(() =>
      noopLineageRecorder.record({
        kind: 'resume',
        fromSessionId: 'ses_fake_1',
        toSessionId: 'ses_fake_1',
        atEpochMs: 0,
      }),
    ).not.toThrow();
  });

  it('SessionIdResolver semantics: map, relay-verbatim, drop', () => {
    const ledger = new Map([['fake-native-0', 'ses_fake_1']]);
    const resolver: SessionIdResolver = (nativeSessionId) => {
      if (nativeSessionId === 'poisoned') return undefined; // drop
      return ledger.get(nativeSessionId) ?? nativeSessionId; // map, else relay
    };
    expect(resolver('fake-native-0')).toBe('ses_fake_1');
    expect(resolver('fake-native-9')).toBe('fake-native-9');
    expect(resolver('poisoned')).toBeUndefined();
  });

  // -- edge ---------------------------------------------------------------------

  it('the frozen edge-type vocabulary is EXACTLY the blueprint §5 set', () => {
    expect([...SESSION_EDGE_TYPES]).toEqual([
      'continue',
      'fork',
      'merge_parent',
      'compact',
      'sidechain',
      'handoff',
      'import',
      'workflow',
    ]);
  });
});

describe('hooks [X4] automation routing (FROZEN-M4)', () => {
  const accepted = (name: string, extra: Record<string, unknown> = {}) => {
    const outcome = validateHookPost('MAX_A', {
      hook_event_name: name,
      session_id: 'synth-native-1',
      ...extra,
    });
    if (!outcome.ok) throw new Error('fixture must be accepted');
    return outcome;
  };

  const injection: HookSessionStartOutput = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '## continuation brief\n\nlatest workstream brief body.',
    },
  };

  // -- positive ---------------------------------------------------------------

  it('routes exactly SessionStart / SessionEnd / PreCompact to the automation slots', () => {
    expect(x4AutomationRouteFor(accepted('SessionStart', { source: 'resume' }).accepted)).toBe(
      'SessionStart',
    );
    expect(x4AutomationRouteFor(accepted('SessionEnd').accepted)).toBe('SessionEnd');
    expect(x4AutomationRouteFor(accepted('PreCompact', { trigger: 'auto' }).accepted)).toBe(
      'PreCompact',
    );
    expect(X4_AUTOMATION_HOOK_EVENTS).toHaveLength(3);
  });

  it('SessionStart injection answers 200 with the CLI hook-output schema', () => {
    const ack = ackForSessionStart(accepted('SessionStart', { source: 'resume' }), injection);
    expect(ack).toEqual({ status: 200, body: injection });
  });

  it('SessionStart with no injection answers 204 (no opinion, the default)', () => {
    expect(ackForSessionStart(accepted('SessionStart', { source: 'startup' }))).toEqual({
      status: 204,
    });
  });

  // -- negative ---------------------------------------------------------------

  it('never routes non-automation events (events-store-only)', () => {
    expect(x4AutomationRouteFor(accepted('PostToolUse', { tool_name: 'Read' }).accepted)).toBeUndefined();
    expect(x4AutomationRouteFor(accepted('SessionUnknownFuture').accepted)).toBeUndefined();
  });

  it('a buggy handler can never inject into a non-SessionStart event', () => {
    expect(ackForSessionStart(accepted('PreCompact'), injection)).toEqual({ status: 204 });
    expect(ackForSessionStart(accepted('PreToolUse', { tool_name: 'Read' }), injection)).toEqual({
      status: 204,
    });
  });

  it('rejections mirror their httpStatus even when an injection is passed', () => {
    const rejected = validateHookPost('PERSONAL', {
      hook_event_name: 'SessionStart',
      session_id: 'synth-native-1',
    });
    expect(ackForSessionStart(rejected, injection)).toEqual({ status: 404 });
  });

  // -- edge ---------------------------------------------------------------------

  it('an empty additionalContext degrades to 204 (never an empty injection)', () => {
    const empty: HookSessionStartOutput = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    };
    expect(ackForSessionStart(accepted('SessionStart', { source: 'clear' }), empty)).toEqual({
      status: 204,
    });
  });
});
