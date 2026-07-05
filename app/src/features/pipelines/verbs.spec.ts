/**
 * Pipeline verbs (plan §9.2 FE-6): the six frozen verbs build in the golden
 * key order, validate through the FROZEN client-message validator, and
 * dispatch to the tracked instrument states (blocked / unsendable / pending);
 * a pushed §18.4 error correlates by requestId (via the store). Byte-shape:
 * an encoded verb envelope matches the corpus fixture (the outbound device).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { encodeEnvelope } from '../../lib/index.ts';
import { validatePipelineClientMessage, type DagDocument } from '@aibender/protocol';
import {
  buildCancelRequest,
  buildLaunchRequest,
  buildPauseRequest,
  buildResumeRequest,
  buildSaveRequest,
  buildValidateRequest,
  dispatchVerb,
  validateVerb,
} from './verbs.ts';
import { pipelinesStore, type PipelineVerbSender } from './index.ts';

const GOLDEN_DOC: DagDocument = {
  schemaVersion: 1,
  id: 'wf_fake_1',
  name: 'golden pipeline',
  steps: [{ kind: 'prompt', id: 'a', prompt: 'do the thing' }],
};

function recordingSender(result: boolean): {
  sender: PipelineVerbSender;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  return {
    sent,
    sender: {
      sendPipelineMessage(message) {
        sent.push(message);
        return result;
      },
    },
  };
}

afterEach(() => {
  pipelinesStore.getState().reset();
});

describe('verb payload builders (golden key order, §18.2)', () => {
  it('validate/save carry the canonical document', () => {
    expect(buildValidateRequest('req_v1', GOLDEN_DOC)).toEqual({
      kind: 'pipeline-validate',
      requestId: 'req_v1',
      document: GOLDEN_DOC,
    });
    expect(buildSaveRequest('req_s1', GOLDEN_DOC).kind).toBe('pipeline-save');
  });

  it('launch names exactly one of pipelineId | document + binds inputs', () => {
    const req = buildLaunchRequest('req_l1', {
      pipelineId: 'wf_fake_1',
      inputs: { paths: ['/synthetic/a.ts'] },
      workstreamId: 'ws_golden',
    });
    // Golden fixture key order: {kind, requestId, pipelineId, inputs, workstreamId}.
    expect(Object.keys(req)).toEqual(['kind', 'requestId', 'pipelineId', 'inputs', 'workstreamId']);
    expect(validatePipelineClientMessage(req).ok).toBe(true);
  });

  it('run verbs (pause/resume/cancel) carry {kind, requestId, runId}', () => {
    for (const [build, kind] of [
      [buildPauseRequest, 'pipeline-pause'],
      [buildResumeRequest, 'pipeline-resume'],
      [buildCancelRequest, 'pipeline-cancel'],
    ] as const) {
      const req = build('req_r', 'run_fake_1');
      expect(req.kind).toBe(kind);
      expect(Object.keys(req)).toEqual(['kind', 'requestId', 'runId']);
    }
  });

  it('an encoded resume verb matches the corpus fixture bytes', () => {
    const frame = encodeEnvelope('pipelines', 3, buildResumeRequest('req_r1', 'run_fake_1'));
    expect(frame).toBe(
      JSON.stringify({
        stream: 'pipelines',
        channel: 'pipelines',
        seq: 3,
        payload: { kind: 'pipeline-resume', requestId: 'req_r1', runId: 'run_fake_1' },
      }),
    );
  });
});

describe('validateVerb (frozen client-message validator delegation)', () => {
  it('a launch naming BOTH pipelineId and document is refused bad-request', () => {
    const verdict = validateVerb(
      buildLaunchRequest('req_l2', { pipelineId: 'wf_fake_1', document: GOLDEN_DOC }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('bad-request');
  });
});

describe('dispatchVerb → tracked instrument states', () => {
  it('valid + sendable → pending, and the payload reaches the wire', () => {
    const { sender, sent } = recordingSender(true);
    const outcome = dispatchVerb(buildResumeRequest('req_p', 'run_1'), {
      store: pipelinesStore,
      sender,
    });
    expect(outcome).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(pipelinesStore.getState().verbs['req_p']?.phase).toBe('pending');
  });

  it('valid but wire down → unsendable (no throw, no toast)', () => {
    const { sender, sent } = recordingSender(false);
    const outcome = dispatchVerb(buildResumeRequest('req_u', 'run_1'), {
      store: pipelinesStore,
      sender,
    });
    expect(outcome).toBe('unsendable');
    expect(sent).toHaveLength(1); // attempted
    expect(pipelinesStore.getState().verbs['req_u']?.phase).toBe('unsendable');
  });

  it('absent sender seam (ICR pending) → unsendable, nothing thrown', () => {
    const outcome = dispatchVerb(buildResumeRequest('req_n', 'run_1'), {
      store: pipelinesStore,
      sender: undefined,
    });
    expect(outcome).toBe('unsendable');
    expect(pipelinesStore.getState().verbs['req_n']?.phase).toBe('unsendable');
  });

  it('client-invalid verb → blocked (server never sees it; broker stays authority)', () => {
    const { sender, sent } = recordingSender(true);
    const outcome = dispatchVerb(
      buildLaunchRequest('req_b', { pipelineId: 'wf_1', document: GOLDEN_DOC }),
      { store: pipelinesStore, sender },
    );
    expect(outcome).toBe('blocked');
    expect(sent).toHaveLength(0); // never sent
    expect(pipelinesStore.getState().verbs['req_b']?.phase).toBe('blocked');
    expect(pipelinesStore.getState().verbs['req_b']?.code).toBe('bad-request');
  });
});
