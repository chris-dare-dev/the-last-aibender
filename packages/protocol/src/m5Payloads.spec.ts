/**
 * M5 freeze surfaces: the `pipelines` channel payload unions (server + client
 * verbs), the catalog + run-monitor vocabularies, the new error codes, and the
 * channel/replay registration. Positive / negative / edge per plan §9.2 (the
 * BE-ORCH contract-package bar). The DAG schema itself has its own exhaustive
 * suite (dag/validate.spec.ts).
 *
 * [X2]: all fixtures synthesized — `cap_fake_*` / `wf_fake_*` / `run_fake_*`
 * ids, `/synthetic/…` paths, placeholder labels, `sha256:deadbeef…` hashes.
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL,
  ERROR_CODES,
  PIPELINE_CLIENT_VERBS,
  PIPELINE_SERVER_PAYLOAD_KINDS,
  PROTOCOL_FREEZE,
  PROTOCOL_VERSION,
  REPLAYABLE_STREAMS,
  isReplayableChannel,
  validatePipelineClientMessage,
  validatePipelineServerPayload,
  type DagDocument,
} from './index.js';

const HASH = 'sha256:deadbeefcafef00d';

const CATALOG_ENTRY = {
  capId: 'cap_fake_1',
  kind: 'skill',
  name: 'write-report',
  scope: 'project',
  backendFamily: 'claude',
  workspace: '/synthetic/workspace',
  sourcePath: '/synthetic/workspace/.claude/skills/write-report/SKILL.md',
  contentHash: HASH,
  slash: '/write-report',
} as const;

function baseDoc(): DagDocument {
  return {
    schemaVersion: 1,
    id: 'wf_fake_doc',
    name: 'synthetic pipeline',
    steps: [{ kind: 'prompt', id: 'a', prompt: 'do it' }],
  };
}

// ---------------------------------------------------------------------------
// Freeze / registration
// ---------------------------------------------------------------------------

describe('M5 protocol freeze registration', () => {
  it('advances the freeze marker + version', () => {
    expect(PROTOCOL_FREEZE).toBe('FROZEN-M5');
    expect(PROTOCOL_VERSION).toBe('1.3.0');
  });

  it('registers the pipelines channel and marks it replayable', () => {
    expect(CHANNEL.PIPELINES).toBe('pipelines');
    expect(REPLAYABLE_STREAMS).toContain('pipelines');
    expect(isReplayableChannel('pipelines')).toBe(true);
  });

  it('carries the four new pipeline error codes', () => {
    for (const code of ['pipeline-not-found', 'pipeline-run-not-found', 'pipeline-invalid', 'step-not-found'] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Server payloads — positive
// ---------------------------------------------------------------------------

describe('validatePipelineServerPayload — positive', () => {
  it('accepts a catalog-snapshot with a full entry', () => {
    const result = validatePipelineServerPayload({
      kind: 'catalog-snapshot',
      capturedAt: 90_000,
      workspace: '/synthetic/workspace',
      entries: [CATALOG_ENTRY],
    });
    expect(result.ok, result.ok ? '' : result.code).toBe(true);
  });

  it('accepts a pipeline-run-snapshot with steps (memoized + awaiting-approval states)', () => {
    const result = validatePipelineServerPayload({
      kind: 'pipeline-run-snapshot',
      capturedAt: 90_000,
      run: { runId: 'run_fake_1', pipelineId: 'wf_fake_doc', state: 'running', resumable: true, schemaHash: HASH },
      steps: [
        { runId: 'run_fake_1', stepId: 'a', iteration: 0, attempt: 0, state: 'memoized', sessionId: 'ses_fake_a', account: 'MAX_A', costEstimatedUsd: 0.01 },
        { runId: 'run_fake_1', stepId: 'gate', iteration: 0, attempt: 0, state: 'awaiting-approval' },
      ],
    });
    expect(result.ok, result.ok ? '' : result.code).toBe(true);
  });

  it('accepts a pipeline-step-status upsert', () => {
    const result = validatePipelineServerPayload({
      kind: 'pipeline-step-status',
      runId: 'run_fake_1',
      stepId: 'audit',
      iteration: 2,
      attempt: 1,
      state: 'running',
      sessionId: 'ses_fake_x',
      account: 'AWS_DEV',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a pipeline-run-status upsert', () => {
    const result = validatePipelineServerPayload({
      kind: 'pipeline-run-status',
      runId: 'run_fake_1',
      pipelineId: 'wf_fake_doc',
      state: 'completed',
      costEstimatedUsd: 1.5,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a valid pipeline-validation-result', () => {
    expect(validatePipelineServerPayload({ kind: 'pipeline-validation-result', requestId: 'req_1', valid: true }).ok).toBe(true);
    expect(
      validatePipelineServerPayload({ kind: 'pipeline-validation-result', requestId: 'req_1', valid: false, issueCode: 'cycle', issueMessage: 'not a DAG', issuePath: 'steps' }).ok,
    ).toBe(true);
  });

  it('accepts a pipeline-saved', () => {
    expect(validatePipelineServerPayload({ kind: 'pipeline-saved', requestId: 'req_1', pipelineId: 'wf_fake_doc' }).ok).toBe(true);
  });

  it('registered server kinds match the exported registry', () => {
    expect(new Set(PIPELINE_SERVER_PAYLOAD_KINDS)).toEqual(
      new Set(['catalog-snapshot', 'pipeline-run-snapshot', 'pipeline-run-status', 'pipeline-step-status', 'pipeline-validation-result', 'pipeline-saved']),
    );
  });
});

// ---------------------------------------------------------------------------
// Server payloads — forward-tolerant + negative
// ---------------------------------------------------------------------------

describe('validatePipelineServerPayload — forward-tolerant + negative', () => {
  it('decodes an unknown kind as opaque (the frozen reader rule)', () => {
    const result = validatePipelineServerPayload({ kind: 'pipeline-cost-rollup-m6', foo: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid');
    expect((result.value as { opaque?: boolean }).opaque).toBe(true);
  });

  it('rejects a kindless payload', () => {
    const result = validatePipelineServerPayload({ capturedAt: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.code).toBe('bad-request');
  });

  it('rejects a catalog entry with a relative sourcePath', () => {
    const result = validatePipelineServerPayload({
      kind: 'catalog-snapshot',
      capturedAt: 1,
      entries: [{ ...CATALOG_ENTRY, sourcePath: 'relative/SKILL.md' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a catalog entry with a bad contentHash', () => {
    const result = validatePipelineServerPayload({
      kind: 'catalog-snapshot',
      capturedAt: 1,
      entries: [{ ...CATALOG_ENTRY, contentHash: 'md5:xyz' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown capability kind', () => {
    const result = validatePipelineServerPayload({
      kind: 'catalog-snapshot',
      capturedAt: 1,
      entries: [{ ...CATALOG_ENTRY, kind: 'lsp' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown pipeline run state', () => {
    const result = validatePipelineServerPayload({ kind: 'pipeline-run-status', runId: 'run_fake_1', pipelineId: 'wf_fake_doc', state: 'exploded' });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown pipeline step state', () => {
    const result = validatePipelineServerPayload({ kind: 'pipeline-step-status', runId: 'run_fake_1', stepId: 'a', iteration: 0, attempt: 0, state: 'vibing' });
    expect(result.ok).toBe(false);
  });

  it('rejects a validation-result that claims valid but carries issue fields', () => {
    const result = validatePipelineServerPayload({ kind: 'pipeline-validation-result', requestId: 'req_1', valid: true, issueCode: 'cycle' });
    expect(result.ok).toBe(false);
  });

  it('rejects a validation-result that claims invalid but omits issue fields', () => {
    const result = validatePipelineServerPayload({ kind: 'pipeline-validation-result', requestId: 'req_1', valid: false });
    expect(result.ok).toBe(false);
  });

  it('rejects a step-status carrying a native session id key ([X2] — this channel is harness-ids only)', () => {
    // The step record has no native id field, so a native-id key is simply
    // dropped (sanitized). Assert it never survives onto the wire type.
    const result = validatePipelineServerPayload({
      kind: 'pipeline-step-status',
      runId: 'run_fake_1',
      stepId: 'a',
      iteration: 0,
      attempt: 0,
      state: 'running',
      nativeSessionId: 'abc-123',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid');
    expect('nativeSessionId' in result.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Client verbs — positive
// ---------------------------------------------------------------------------

describe('validatePipelineClientMessage — positive', () => {
  it('registered client verbs match the exported registry', () => {
    expect(new Set(PIPELINE_CLIENT_VERBS)).toEqual(
      new Set(['pipeline-validate', 'pipeline-save', 'pipeline-launch', 'pipeline-pause', 'pipeline-resume', 'pipeline-cancel']),
    );
  });

  it('accepts pipeline-validate with a well-formed document', () => {
    const result = validatePipelineClientMessage({ kind: 'pipeline-validate', requestId: 'req_1', document: baseDoc() });
    expect(result.ok, result.ok ? '' : result.code).toBe(true);
  });

  it('accepts pipeline-save with a document', () => {
    expect(validatePipelineClientMessage({ kind: 'pipeline-save', requestId: 'req_1', document: baseDoc() }).ok).toBe(true);
  });

  it('accepts pipeline-launch with a pipelineId (saved) + inputs + workstreamId', () => {
    const result = validatePipelineClientMessage({
      kind: 'pipeline-launch',
      requestId: 'req_1',
      pipelineId: 'wf_fake_doc',
      inputs: { paths: ['/synthetic/a.ts'] },
      workstreamId: 'ws_fake_1',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts pipeline-launch with an inline document', () => {
    expect(validatePipelineClientMessage({ kind: 'pipeline-launch', requestId: 'req_1', document: baseDoc() }).ok).toBe(true);
  });

  it('accepts the run verbs (pause/resume/cancel)', () => {
    for (const kind of ['pipeline-pause', 'pipeline-resume', 'pipeline-cancel'] as const) {
      expect(validatePipelineClientMessage({ kind, requestId: 'req_1', runId: 'run_fake_1' }).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Client verbs — negative
// ---------------------------------------------------------------------------

describe('validatePipelineClientMessage — negative', () => {
  it('rejects an unknown verb', () => {
    const result = validatePipelineClientMessage({ kind: 'pipeline-teleport', requestId: 'req_1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.code).toBe('bad-request');
  });

  it('rejects a missing requestId', () => {
    expect(validatePipelineClientMessage({ kind: 'pipeline-pause', runId: 'run_fake_1' }).ok).toBe(false);
  });

  it('rejects pipeline-validate carrying a structurally invalid DAG (cycle)', () => {
    const result = validatePipelineClientMessage({
      kind: 'pipeline-validate',
      requestId: 'req_1',
      document: { schemaVersion: 1, id: 'wf_fake_c', name: 'cyclic', steps: [{ id: 'a', kind: 'prompt', prompt: 'p', needs: ['a'] }] },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects pipeline-launch that names BOTH a pipelineId and a document', () => {
    const result = validatePipelineClientMessage({ kind: 'pipeline-launch', requestId: 'req_1', pipelineId: 'wf_fake_doc', document: baseDoc() });
    expect(result.ok).toBe(false);
  });

  it('rejects pipeline-launch that names NEITHER a pipelineId nor a document', () => {
    expect(validatePipelineClientMessage({ kind: 'pipeline-launch', requestId: 'req_1' }).ok).toBe(false);
  });

  it('rejects a run verb with a malformed runId', () => {
    expect(validatePipelineClientMessage({ kind: 'pipeline-cancel', requestId: 'req_1', runId: 'has space' }).ok).toBe(false);
  });

  it('rejects a non-object message', () => {
    expect(validatePipelineClientMessage(null).ok).toBe(false);
    expect(validatePipelineClientMessage([]).ok).toBe(false);
  });
});
