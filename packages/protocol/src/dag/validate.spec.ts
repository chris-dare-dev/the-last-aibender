/**
 * Exhaustive DAG-document validation tests (dag-schema.md v1; plan §9.2
 * positive/negative/edge for BE-ORCH's frozen schema). Every validation
 * semantic named in the BE-8 brief has a negative case here: cycle detection,
 * unknown-step-kind, dangling needs, invalid account label, unsupported
 * version, duplicate step id, account/backend consistency, forEach/loop
 * exclusivity, budget/retry bounds, and the [X2] naming screen.
 *
 * [X2]: all fixtures are synthesized — `wf_fake_*` ids, `/synthetic/…` paths,
 * placeholder labels.
 */

import { describe, expect, it } from 'vitest';

import {
  DAG_SCHEMA_VERSION,
  STEP_KINDS,
  validateDagDocument,
  type DagDocument,
} from './index.js';

/** A minimal always-valid single-step document (the positive baseline). */
function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DAG_SCHEMA_VERSION,
    id: 'wf_fake_base',
    name: 'synthetic pipeline',
    steps: [{ id: 'step_a', kind: 'prompt', prompt: 'do the thing' }],
    ...overrides,
  };
}

describe('validateDagDocument — positive', () => {
  it('accepts the minimal single-prompt-step document', () => {
    const result = validateDagDocument(baseDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid');
    expect(result.document.schemaVersion).toBe(DAG_SCHEMA_VERSION);
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0]?.kind).toBe('prompt');
  });

  it('accepts a multi-account DAG with needs, forEach, an approval gate, and a skill step (the M5 DoD demo shape)', () => {
    const doc = baseDoc({
      id: 'wf_fake_demo',
      name: 'research-audit-synthesize',
      description: 'MAX_A research → approval → AWS_DEV audit → LOCAL summary',
      defaults: { account: 'MAX_A', permissionMode: 'default', cwd: '/synthetic/workspace' },
      inputs: { paths: { type: 'array', items: { type: 'string' } } },
      steps: [
        { id: 'inventory', kind: 'prompt', prompt: 'List handlers under ${inputs.paths}', outputSchema: { type: 'object' } },
        {
          id: 'audit',
          kind: 'agent',
          needs: ['inventory'],
          forEach: '${steps.inventory.output.files}',
          maxParallel: 4,
          account: 'AWS_DEV',
          backend: 'bedrock',
          agent: { name: 'security-reviewer', scope: 'project' },
          prompt: 'Audit ${item}',
          budget: { usd: 2, turns: 30, wallClockSec: 900 },
          retry: { max: 2, backoffSec: 30, retryOn: ['rate_limit', 'overloaded'] },
          onError: 'continue',
        },
        { id: 'gate', kind: 'approval', needs: ['audit'], summary: 'review the audit', timeoutSec: 86400, onTimeout: 'fail' },
        { id: 'synth', kind: 'skill', needs: ['gate'], skill: { name: 'write-report', args: '${steps.audit.outputs}' }, account: 'ENT', when: '${steps.audit.outputs.length} > 0' },
        { id: 'summary', kind: 'prompt', needs: ['synth'], account: 'LOCAL', backend: 'lmstudio', prompt: 'Summarize ${steps.synth.output}' },
      ],
    });
    const result = validateDagDocument(doc);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issue)).toBe(true);
    if (!result.ok) throw new Error('expected valid');
    expect(result.document.steps).toHaveLength(5);
  });

  it('accepts a loop step with until + maxIterations', () => {
    const result = validateDagDocument(
      baseDoc({
        steps: [
          { id: 'fix', kind: 'prompt', prompt: 'fix until green', loop: { until: '${steps.fix.output.passed}', maxIterations: 5 } },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a workflow-script interop step', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'native', kind: 'workflow-script', scriptPath: '/synthetic/.claude/workflows/audit.js' }] }),
    );
    expect(result.ok).toBe(true);
  });

  it('drops unknown top-level and step keys (sanitized output, [X2])', () => {
    const result = validateDagDocument(baseDoc({ bogusTopKey: 'x', steps: [{ id: 'step_a', kind: 'prompt', prompt: 'p', junk: 1 }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid');
    expect('bogusTopKey' in result.document).toBe(false);
    expect('junk' in (result.document.steps[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('every declared step kind is understood by the validator', () => {
    // Sanity: the STEP_KINDS registry and the validator switch agree.
    expect(new Set(STEP_KINDS)).toEqual(
      new Set(['prompt', 'skill', 'agent', 'workflow-script', 'approval']),
    );
  });
});

describe('validateDagDocument — negative (frozen error classes)', () => {
  it('unsupported-version: unknown schemaVersion is refused (never forward-tolerant)', () => {
    const result = validateDagDocument(baseDoc({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('unsupported-version');
  });

  it('unsupported-version: a missing schemaVersion is refused', () => {
    const doc = baseDoc();
    delete (doc as Record<string, unknown>)['schemaVersion'];
    const result = validateDagDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('unsupported-version');
  });

  it('unknown-step-kind: a step kind outside the registry is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'x', kind: 'bash', script: 'rm -rf /' }] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('unknown-step-kind');
  });

  it('dangling-needs: a needs referencing a non-existent step is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', needs: ['ghost'] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('dangling-needs');
  });

  it('dangling-needs: a goto onError target referencing no step is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', onError: 'goto:nowhere' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('dangling-needs');
  });

  it('duplicate-step-id: two steps sharing an id is refused', () => {
    const result = validateDagDocument(
      baseDoc({
        steps: [
          { id: 'dup', kind: 'prompt', prompt: 'one' },
          { id: 'dup', kind: 'prompt', prompt: 'two' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('duplicate-step-id');
  });

  it('cycle: a 2-node needs cycle is refused', () => {
    const result = validateDagDocument(
      baseDoc({
        steps: [
          { id: 'a', kind: 'prompt', prompt: 'a', needs: ['b'] },
          { id: 'b', kind: 'prompt', prompt: 'b', needs: ['a'] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('cycle');
  });

  it('cycle: a self-needs cycle is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'a', needs: ['a'] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('cycle');
  });

  it('cycle: a longer 3-node cycle is refused', () => {
    const result = validateDagDocument(
      baseDoc({
        steps: [
          { id: 'a', kind: 'prompt', prompt: 'a', needs: ['c'] },
          { id: 'b', kind: 'prompt', prompt: 'b', needs: ['a'] },
          { id: 'c', kind: 'prompt', prompt: 'c', needs: ['b'] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('cycle');
  });

  it('invalid-account: an unknown account label is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', account: 'PROD' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('invalid-account');
  });

  it('invalid-account: an account/backend mismatch is refused (MAX_A cannot run lmstudio)', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', account: 'MAX_A', backend: 'lmstudio' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('invalid-account');
  });

  it('invalid-account: an unknown account in document defaults is refused', () => {
    const result = validateDagDocument(baseDoc({ defaults: { account: 'STAGING' } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('invalid-account');
  });
});

describe('validateDagDocument — bad-shape edges', () => {
  it('empty steps array is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('bad-shape');
  });

  it('forEach + loop on one step is refused', () => {
    const result = validateDagDocument(
      baseDoc({
        steps: [{ id: 'a', kind: 'prompt', prompt: 'p', forEach: '${x}', loop: { until: '${y}', maxIterations: 3 } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('bad-shape');
  });

  it('maxParallel without forEach is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', maxParallel: 3 }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('bad-shape');
  });

  it('maxParallel over the native cap (16) is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', forEach: '${x}', maxParallel: 17 }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('an empty budget (no fields) is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', budget: {} }] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('bad-shape');
  });

  it('a non-positive budget.usd is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', budget: { usd: 0 } }] }));
    expect(result.ok).toBe(false);
  });

  it('retry.max over 10 is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', retry: { max: 11 } }] }));
    expect(result.ok).toBe(false);
  });

  it('an unknown retry.retryOn class is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', retry: { max: 1, retryOn: ['meltdown'] } }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('a prompt step without a prompt is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt' }] }));
    expect(result.ok).toBe(false);
  });

  it('a skill step without a skill ref is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'skill' }] }));
    expect(result.ok).toBe(false);
  });

  it('an agent step without a prompt is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'agent', agent: { name: 'x' } }] }));
    expect(result.ok).toBe(false);
  });

  it('a workflow-script step with a relative scriptPath is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'workflow-script', scriptPath: './rel.js' }] }));
    expect(result.ok).toBe(false);
  });

  it('a malformed step id is refused', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'has space', kind: 'prompt', prompt: 'p' }] }));
    expect(result.ok).toBe(false);
  });

  it('an outputSchema without a string type is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', outputSchema: { properties: {} } }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('an invalid permissionMode is refused', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', permissionMode: 'yolo' }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('a relative (non-template) cwd is refused; a ${template} cwd is accepted', () => {
    expect(validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', cwd: 'relative/dir' }] })).ok).toBe(false);
    expect(validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'p', cwd: '${workspace}' }] })).ok).toBe(true);
  });

  it('a non-object document is refused', () => {
    expect(validateDagDocument(null).ok).toBe(false);
    expect(validateDagDocument('x').ok).toBe(false);
    expect(validateDagDocument([]).ok).toBe(false);
  });
});

describe('validateDagDocument — [X2] naming screen', () => {
  it('rejects an email-shaped literal in the document name', () => {
    const result = validateDagDocument(baseDoc({ name: 'pipeline for someone@example.com' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.issue.code).toBe('bad-shape');
  });

  it('rejects a 12-digit run in a prompt (AWS-account shaped)', () => {
    const result = validateDagDocument(baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'deploy to 123456789012' }] }));
    expect(result.ok).toBe(false);
  });

  it('rejects an email-shaped capability name', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'skill', skill: { name: 'evil@example.com' } }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('allows an absolute path in a prompt (paths are legal, redacted downstream)', () => {
    const result = validateDagDocument(
      baseDoc({ steps: [{ id: 'a', kind: 'prompt', prompt: 'edit /synthetic/workspace/src/index.ts' }] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateDagDocument — round-trip sanity', () => {
  it('a validated document re-validates identically (idempotent, JSON-stable)', () => {
    const first = validateDagDocument(baseDoc({ id: 'wf_fake_rt', name: 'roundtrip' }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected valid');
    const doc: DagDocument = first.document;
    const second = validateDagDocument(JSON.parse(JSON.stringify(doc)));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected valid');
    expect(second.document).toEqual(doc);
  });
});
