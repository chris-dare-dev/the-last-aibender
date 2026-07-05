/**
 * Builder DAG model (plan §9.2 FE-6 positive/negative/edge): the builder emits
 * SCHEMA-VALID DAG JSON; an invalid DAG (cycle, missing/invalid account) is
 * blocked CLIENT-side with the frozen issue class (the server stays the
 * authority for everything sent); the serialized canonical document is
 * byte-identical to the same document canonicalized by the frozen validator
 * (the corpus device — a builder frame is byte-comparable against the corpus).
 */

import { describe, expect, it } from 'vitest';
import { encodeEnvelope } from '../../lib/index.ts';
import { validateDagDocument } from '@aibender/protocol';
import {
  addEdge,
  addNode,
  canonicalDocument,
  emptyBuilderDoc,
  removeNode,
  serializeBuilderDoc,
  updateNode,
  validateBuilderDoc,
  type BuilderDoc,
} from './dagModel.ts';
import { buildValidateRequest } from './verbs.ts';
import { adversarialStrings } from './specHelpers.ts';

/** The corpus GOLDEN_DAG_DOCUMENT (synthesized here in the raw fixture order). */
const GOLDEN_RAW = {
  schemaVersion: 1,
  id: 'wf_fake_1',
  name: 'golden pipeline',
  steps: [{ id: 'a', kind: 'prompt', prompt: 'do the thing' }],
} as const;

describe('builder composition → schema-valid DAG (positive)', () => {
  it('a prompt step composes to a document the frozen validator accepts', () => {
    const doc = addNode(emptyBuilderDoc('wf_fake_1', 'golden pipeline'), {
      id: 'a',
      kind: 'prompt',
      prompt: 'do the thing',
    });
    const verdict = validateBuilderDoc(doc);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.document.schemaVersion).toBe(1);
      expect(verdict.document.steps).toHaveLength(1);
      expect(verdict.document.steps[0]?.kind).toBe('prompt');
    }
  });

  it('per-step account routing survives serialization (the [X1] differentiator)', () => {
    const doc: BuilderDoc = {
      id: 'wf_route',
      name: 'multi-account',
      nodes: [
        { id: 'a', kind: 'prompt', prompt: 'on max', account: 'MAX_A' },
        { id: 'b', kind: 'prompt', prompt: 'on aws', account: 'AWS_DEV', backend: 'bedrock', needs: ['a'] },
        { id: 'c', kind: 'prompt', prompt: 'on local', account: 'LOCAL', needs: ['b'] },
      ],
    };
    const doc2 = canonicalDocument(doc);
    expect(doc2).toBeDefined();
    const accounts = doc2?.steps.map((s) => ('account' in s ? s.account : undefined));
    expect(accounts).toEqual(['MAX_A', 'AWS_DEV', 'LOCAL']);
  });

  it('the approval gate is a first-class node kind (no account, gate fields only)', () => {
    const doc: BuilderDoc = {
      id: 'wf_gate',
      name: 'gated',
      nodes: [
        { id: 'a', kind: 'prompt', prompt: 'first', account: 'MAX_A' },
        { id: 'gate', kind: 'approval', summary: 'review', needs: ['a'], onTimeout: 'fail' },
        { id: 'b', kind: 'prompt', prompt: 'after', account: 'AWS_DEV', needs: ['gate'] },
      ],
    };
    const verdict = validateBuilderDoc(doc);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      const gate = verdict.document.steps[1];
      expect(gate?.kind).toBe('approval');
      // approval carries NO account — it spawns no session (dag-schema.md §2).
      expect('account' in (gate as object)).toBe(false);
    }
  });

  it('addEdge / removeNode keep the needs graph consistent (no dangling edge)', () => {
    let doc: BuilderDoc = {
      id: 'wf_edit',
      name: 'edited',
      nodes: [
        { id: 'a', kind: 'prompt', prompt: 'a' },
        { id: 'b', kind: 'prompt', prompt: 'b' },
      ],
    };
    doc = addEdge(doc, 'a', 'b');
    expect(doc.nodes[1]?.needs).toEqual(['a']);
    doc = removeNode(doc, 'a');
    // b's needs must no longer reference the removed a.
    expect(doc.nodes[0]?.needs ?? []).toEqual([]);
    expect(validateBuilderDoc(doc).ok).toBe(true);
  });
});

describe('builder composition → blocked client-side (negative)', () => {
  it('a cycle is blocked with `cycle` (the server never sees it)', () => {
    const doc: BuilderDoc = {
      id: 'wf_cyc',
      name: 'cyclic',
      nodes: [
        { id: 'a', kind: 'prompt', prompt: 'a', needs: ['b'] },
        { id: 'b', kind: 'prompt', prompt: 'b', needs: ['a'] },
      ],
    };
    const verdict = validateBuilderDoc(doc);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issue.code).toBe('cycle');
  });

  it('an invalid account/backend pairing is blocked with `invalid-account`', () => {
    const doc: BuilderDoc = {
      id: 'wf_bad',
      name: 'bad-route',
      // MAX_A only admits `claude`; lmstudio is inconsistent (§3).
      nodes: [{ id: 'a', kind: 'prompt', prompt: 'x', account: 'MAX_A', backend: 'lmstudio' }],
    };
    const verdict = validateBuilderDoc(doc);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issue.code).toBe('invalid-account');
  });

  it('an empty canvas is blocked with `bad-shape` (steps must be non-empty)', () => {
    const verdict = validateBuilderDoc(emptyBuilderDoc('wf_empty', 'nothing'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issue.code).toBe('bad-shape');
  });

  it('an identity-shaped literal in a name is blocked with `bad-shape` [X2]', () => {
    const { emailish } = adversarialStrings();
    const doc = addNode(emptyBuilderDoc('wf_x2', emailish), {
      id: 'a',
      kind: 'prompt',
      prompt: 'safe',
    });
    const verdict = validateBuilderDoc(doc);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issue.code).toBe('bad-shape');
  });
});

describe('serialization byte-identity (the corpus device, §18.2)', () => {
  it('a canonicalized builder doc equals the validator-canonicalized corpus doc', () => {
    // The corpus fixture's RAW document, canonicalized by the frozen validator.
    const canonicalGolden = validateDagDocument(GOLDEN_RAW);
    expect(canonicalGolden.ok).toBe(true);

    // The builder composes the same shape; its canonical form must match.
    const built = canonicalDocument(
      addNode(emptyBuilderDoc('wf_fake_1', 'golden pipeline'), {
        id: 'a',
        kind: 'prompt',
        prompt: 'do the thing',
      }),
    );
    expect(built).toBeDefined();
    if (canonicalGolden.ok && built !== undefined) {
      // Byte-identical: JSON.stringify preserves the validator's canonical key
      // order on both sides, so the encoded verb envelopes match to the byte.
      expect(JSON.stringify(built)).toBe(JSON.stringify(canonicalGolden.document));
      const requestId = 'req_v1';
      const builtFrame = encodeEnvelope('pipelines', 0, buildValidateRequest(requestId, built));
      const goldenFrame = encodeEnvelope(
        'pipelines',
        0,
        buildValidateRequest(requestId, canonicalGolden.document),
      );
      expect(builtFrame).toBe(goldenFrame);
    }
  });

  it('serializeBuilderDoc drops undefined keys and unknown fields [X2]', () => {
    const raw = serializeBuilderDoc({
      id: 'wf_clean',
      name: 'clean',
      nodes: [{ id: 'a', kind: 'prompt', prompt: 'p', account: 'MAX_A' }],
    });
    expect(raw['description']).toBeUndefined();
    expect(raw['defaults']).toBeUndefined();
    expect(Object.keys(raw)).toEqual(['schemaVersion', 'id', 'name', 'steps']);
  });

  it('updateNode is identity-preserving on other nodes', () => {
    const doc: BuilderDoc = {
      id: 'wf_up',
      name: 'up',
      nodes: [
        { id: 'a', kind: 'prompt', prompt: 'a' },
        { id: 'b', kind: 'prompt', prompt: 'b' },
      ],
    };
    const next = updateNode(doc, 'a', { account: 'ENT' });
    expect(next.nodes[0]?.account).toBe('ENT');
    expect(next.nodes[1]).toBe(doc.nodes[1]); // untouched node reference preserved
  });
});
