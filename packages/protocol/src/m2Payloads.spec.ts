/**
 * M2-freeze payload suites: transcript / approvals / quota / context-graph /
 * json-replay validators (plan §9.2 positive/negative/edge; §3 "M1 core, M2
 * full"). Golden wire-frame pins live in @aibender/testkit (wsGolden.ts);
 * these suites cover the validator behavior matrix directly.
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_OUTCOMES,
  APPROVAL_SOURCES,
  APPROVAL_VERDICTS,
  CONTEXT_GRAPH_RELATIONS,
  QUOTA_SOURCES,
  QUOTA_WINDOWS,
  REPLAYABLE_STREAMS,
  TRANSCRIPT_PAYLOAD_KINDS,
  isReplayableChannel,
  validateApprovalsClientMessage,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateJsonReplayRequest,
  validateQuotaSnapshot,
  validateTranscriptPayload,
} from './index.js';

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

describe('M2 registries are closed and exact', () => {
  it('pins every M2 vocabulary', () => {
    expect([...TRANSCRIPT_PAYLOAD_KINDS]).toEqual([
      'transcript-delta',
      'transcript-tool',
      'transcript-result',
    ]);
    expect([...APPROVAL_SOURCES]).toEqual(['can-use-tool', 'hook-floor', 'workflow-gate']);
    expect([...APPROVAL_VERDICTS]).toEqual(['allow', 'deny']);
    expect([...APPROVAL_OUTCOMES]).toEqual(['allowed', 'denied', 'expired', 'superseded']);
    expect([...QUOTA_WINDOWS]).toEqual(['5h', '7d', '7d_sonnet']);
    expect([...QUOTA_SOURCES]).toEqual(['statusline', 'oauth-poll']);
    expect([...CONTEXT_GRAPH_RELATIONS]).toEqual(['read', 'write', 'instructions', 'watched']);
    // `workstream` joined the replayable set at the M4 freeze (amendment-
    // recorded in ws-protocol.md §8/§16); the M2 five are unchanged.
    expect([...REPLAYABLE_STREAMS].sort()).toEqual(
      ['approvals', 'context-graph', 'events', 'quota', 'transcript', 'workstream'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// transcript.<sid>
// ---------------------------------------------------------------------------

const delta = (over: Record<string, unknown> = {}) => ({
  kind: 'transcript-delta',
  sessionId: 'ses_1',
  messageUuid: 'synthmsg-0',
  text: 'synthesized delta',
  ...over,
});

const toolStart = (over: Record<string, unknown> = {}) => ({
  kind: 'transcript-tool',
  sessionId: 'ses_1',
  toolUseId: 'synthtool-0',
  toolName: 'Read',
  phase: 'start',
  ...over,
});

const result = (over: Record<string, unknown> = {}) => ({
  kind: 'transcript-result',
  sessionId: 'ses_1',
  ok: true,
  detail: 'success',
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0 },
  ...over,
});

describe('validateTranscriptPayload', () => {
  // -- positive --------------------------------------------------------------

  it('accepts delta / tool start / tool result / result, and strips unknown keys', () => {
    expect(validateTranscriptPayload(delta(), 'ses_1').ok).toBe(true);
    expect(validateTranscriptPayload(toolStart(), 'ses_1').ok).toBe(true);
    expect(
      validateTranscriptPayload(toolStart({ phase: 'result', ok: false }), 'ses_1').ok,
    ).toBe(true);
    const full = validateTranscriptPayload(
      result({ costUsd: 0.0123, durationMs: 4200, junk: 'dropme' }),
      'ses_1',
    );
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value).not.toHaveProperty('junk');
      expect(full.value.kind === 'transcript-result' && full.value.costUsd).toBe(0.0123);
    }
  });

  // -- negative --------------------------------------------------------------

  it('rejects unknown kinds, malformed/mismatched session ids and empty deltas', () => {
    expect(validateTranscriptPayload(delta({ kind: 'transcript-noise' }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(delta({ sessionId: 'has space' }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(delta(), 'ses_OTHER').ok).toBe(false);
    expect(validateTranscriptPayload(delta({ text: '' }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload('not-an-object', 'ses_1').ok).toBe(false);
  });

  it('enforces the tool phase/ok matrix: ok forbidden on start, required on result', () => {
    expect(validateTranscriptPayload(toolStart({ ok: true }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(toolStart({ phase: 'result' }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(toolStart({ phase: 'running' }), 'ses_1').ok).toBe(false);
  });

  it('rejects malformed usage and negative cost/duration', () => {
    expect(
      validateTranscriptPayload(
        result({ usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
        'ses_1',
      ).ok,
    ).toBe(false);
    expect(validateTranscriptPayload(result({ usage: undefined }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(result({ costUsd: -0.5 }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(result({ costUsd: Number.NaN }), 'ses_1').ok).toBe(false);
    expect(validateTranscriptPayload(result({ durationMs: 1.5 }), 'ses_1').ok).toBe(false);
  });

  // -- edge --------------------------------------------------------------------

  it('accepts a zero-usage result and works without an expectedSessionId', () => {
    expect(
      validateTranscriptPayload(
        result({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

const request = (over: Record<string, unknown> = {}) => ({
  kind: 'approval-request',
  approvalId: 'apr_001',
  source: 'can-use-tool',
  summary: 'synthesized tool escalation',
  accountLabel: 'MAX_A',
  sessionId: 'ses_1',
  toolName: 'Bash',
  ...over,
});

describe('validateApprovalsServerMessage', () => {
  // -- positive --------------------------------------------------------------

  it('accepts requests for all three sources with their per-source fields', () => {
    expect(validateApprovalsServerMessage(request()).ok).toBe(true);
    expect(
      validateApprovalsServerMessage(request({ source: 'hook-floor', toolUseId: 'synthtool-9', expiresAt: 1 })).ok,
    ).toBe(true);
    expect(
      validateApprovalsServerMessage(
        request({
          source: 'workflow-gate',
          sessionId: undefined,
          toolName: undefined,
          runId: 'run_1',
          stepId: 'step_2',
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts every registered outcome on approval-resolved', () => {
    for (const outcome of APPROVAL_OUTCOMES) {
      expect(
        validateApprovalsServerMessage({ kind: 'approval-resolved', approvalId: 'apr_001', outcome }).ok,
        outcome,
      ).toBe(true);
    }
  });

  // -- negative --------------------------------------------------------------

  it('rejects unknown kinds, sources, outcomes and malformed ids', () => {
    expect(validateApprovalsServerMessage(request({ kind: 'approval-ping' })).ok).toBe(false);
    expect(validateApprovalsServerMessage(request({ source: 'vibes' })).ok).toBe(false);
    expect(validateApprovalsServerMessage(request({ approvalId: 'bad id!' })).ok).toBe(false);
    expect(validateApprovalsServerMessage(request({ accountLabel: 'REAL_NAME' })).ok).toBe(false);
    expect(
      validateApprovalsServerMessage({ kind: 'approval-resolved', approvalId: 'apr_001', outcome: 'shrugged' }).ok,
    ).toBe(false);
  });

  it('enforces the per-source field matrix', () => {
    // can-use-tool / hook-floor: sessionId + toolName required, run refs forbidden.
    expect(validateApprovalsServerMessage(request({ sessionId: undefined })).ok).toBe(false);
    expect(validateApprovalsServerMessage(request({ toolName: undefined })).ok).toBe(false);
    expect(validateApprovalsServerMessage(request({ runId: 'run_1', stepId: 'step_1' })).ok).toBe(false);
    // workflow-gate: run refs required, tool refs forbidden.
    expect(
      validateApprovalsServerMessage(request({ source: 'workflow-gate', toolName: undefined })).ok,
    ).toBe(false);
    expect(
      validateApprovalsServerMessage(
        request({ source: 'workflow-gate', runId: 'run_1', stepId: 'step_1' }),
      ).ok,
    ).toBe(false); // still carries toolName from the builder default
  });
});

describe('validateApprovalsClientMessage', () => {
  // -- positive --------------------------------------------------------------

  it('accepts allow (with updatedInput) and deny (with note)', () => {
    expect(
      validateApprovalsClientMessage({
        kind: 'approval-decision',
        approvalId: 'apr_001',
        verdict: 'allow',
        updatedInput: { command: 'ls -la' },
      }).ok,
    ).toBe(true);
    expect(
      validateApprovalsClientMessage({
        kind: 'approval-decision',
        approvalId: 'apr_001',
        verdict: 'deny',
        note: 'synthesized denial rationale',
      }).ok,
    ).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('rejects broker-side kinds, unknown verdicts and updatedInput-on-deny', () => {
    expect(validateApprovalsClientMessage(request()).ok).toBe(false);
    expect(
      validateApprovalsClientMessage({ kind: 'approval-decision', approvalId: 'apr_001', verdict: 'maybe' }).ok,
    ).toBe(false);
    expect(
      validateApprovalsClientMessage({
        kind: 'approval-decision',
        approvalId: 'apr_001',
        verdict: 'deny',
        updatedInput: {},
      }).ok,
    ).toBe(false);
    expect(
      validateApprovalsClientMessage({
        kind: 'approval-decision',
        approvalId: 'apr_001',
        verdict: 'allow',
        updatedInput: ['not', 'a', 'record'],
      }).ok,
    ).toBe(false);
  });

  // -- edge --------------------------------------------------------------------

  it('accepts a bare minimal decision and strips unknown keys', () => {
    const decision = validateApprovalsClientMessage({
      kind: 'approval-decision',
      approvalId: 'a',
      verdict: 'allow',
      junk: true,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value).not.toHaveProperty('junk');
  });
});

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

const snapshot = (over: Record<string, unknown> = {}) => ({
  kind: 'quota-snapshot',
  account: 'MAX_A',
  window: '5h',
  usedPct: 41.5,
  resetsAt: 90_200_000,
  capturedAt: 90_100_000,
  source: 'statusline',
  ...over,
});

describe('validateQuotaSnapshot', () => {
  it('accepts every window and source combination', () => {
    for (const window of QUOTA_WINDOWS) {
      for (const source of QUOTA_SOURCES) {
        expect(validateQuotaSnapshot(snapshot({ window, source })).ok, `${window}/${source}`).toBe(true);
      }
    }
  });

  it('rejects unknown window/source/account, out-of-range percentages and bad instants', () => {
    expect(validateQuotaSnapshot(snapshot({ window: '24h' })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ source: 'crystal-ball' })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ account: 'REAL_ACCOUNT' })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ usedPct: -0.1 })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ usedPct: 100.1 })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ usedPct: Number.POSITIVE_INFINITY })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ resetsAt: -1 })).ok).toBe(false);
    expect(validateQuotaSnapshot(snapshot({ capturedAt: 1.5 })).ok).toBe(false);
  });

  it('edge: 0% and exactly 100% are both legal (reset-due rendering is FE concern)', () => {
    expect(validateQuotaSnapshot(snapshot({ usedPct: 0 })).ok).toBe(true);
    expect(validateQuotaSnapshot(snapshot({ usedPct: 100 })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// context-graph
// ---------------------------------------------------------------------------

const touch = (over: Record<string, unknown> = {}) => ({
  kind: 'context-touch',
  sessionId: 'ses_1',
  path: '/synthetic/workspace/file.ts',
  relation: 'read',
  ts: 90_100_000,
  ...over,
});

describe('validateContextGraphTouch', () => {
  it('accepts every relation', () => {
    for (const relation of CONTEXT_GRAPH_RELATIONS) {
      expect(validateContextGraphTouch(touch({ relation })).ok, relation).toBe(true);
    }
  });

  it('rejects relative paths, unknown relations and malformed fields', () => {
    expect(validateContextGraphTouch(touch({ path: 'relative/path.ts' })).ok).toBe(false);
    expect(validateContextGraphTouch(touch({ path: '' })).ok).toBe(false);
    expect(validateContextGraphTouch(touch({ relation: 'skimmed' })).ok).toBe(false);
    expect(validateContextGraphTouch(touch({ sessionId: 'has space' })).ok).toBe(false);
    expect(validateContextGraphTouch(touch({ ts: -5 })).ok).toBe(false);
  });

  it('[X2] design pin: payloads carrying account keys are rejected outright', () => {
    expect(validateContextGraphTouch(touch({ account: 'MAX_A' })).ok).toBe(false);
    expect(validateContextGraphTouch(touch({ accountLabel: 'MAX_A' })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// json replay
// ---------------------------------------------------------------------------

describe('validateJsonReplayRequest / isReplayableChannel', () => {
  it('accepts replay on every replayable channel and cross-checks the envelope channel', () => {
    for (const channel of ['events', 'quota', 'approvals', 'context-graph', 'transcript.ses_1'] as const) {
      const parsed = validateJsonReplayRequest(
        { kind: 'replay-request', channel, fromSeq: 0 },
        channel,
      );
      expect(parsed.ok, channel).toBe(true);
      expect(isReplayableChannel(channel), channel).toBe(true);
    }
  });

  it('rejects non-replayable channels: control correlates by id, pty replays on bytes', () => {
    expect(isReplayableChannel('control')).toBe(false);
    expect(isReplayableChannel('pty.ses_1')).toBe(false);
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'control', fromSeq: 0 }, 'control').ok,
    ).toBe(false);
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'pty.ses_1', fromSeq: 0 }, 'pty.ses_1').ok,
    ).toBe(false);
  });

  it('rejects channel mismatch, malformed channels and bad fromSeq', () => {
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'events', fromSeq: 0 }, 'quota').ok,
    ).toBe(false);
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'transcript.', fromSeq: 0 }).ok,
    ).toBe(false);
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'events', fromSeq: -1 }, 'events').ok,
    ).toBe(false);
    expect(
      validateJsonReplayRequest({ kind: 'replay-request', channel: 'events', fromSeq: 1.5 }, 'events').ok,
    ).toBe(false);
    expect(validateJsonReplayRequest({ kind: 'replay' }, 'events').ok).toBe(false);
  });

  it('edge: fromSeq 0 (full retained history) and huge-but-safe integers are legal', () => {
    expect(
      validateJsonReplayRequest(
        { kind: 'replay-request', channel: 'events', fromSeq: Number.MAX_SAFE_INTEGER },
        'events',
      ).ok,
    ).toBe(true);
  });
});
