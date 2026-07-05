// @vitest-environment jsdom
/**
 * The merge flow — client half of the FROZEN verb (ws-protocol.md §16.2–.4;
 * plan §9.2 FE-6 "merge-flow round-trip against the frozen envelopes"):
 * Positive: buildMergeRequest is BYTE-comparable against the golden corpus
 *           frame; select N nodes → preview → dispatch → the fake sender
 *           receives the frozen envelope → the resolution renders the new
 *           node with its merge_parent edges.
 * Negative: every §16.4 shape class is refused CLIENT-side (`blocked`, the
 *           exact frozen validator) and never sent; wire failures land as
 *           `failed` with the frozen codes.
 * Edge:     no sender / wire down ⇒ the `unsendable` instrument state (never
 *           a throw, never a toast); preview masks identity-shaped text.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { validateWorkstreamClientMessage, type WorkstreamMergeRequest } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { connectionStore, encodeEnvelope } from '../../lib/index.ts';
import {
  assembleMergePreview,
  buildMergeRequest,
  dispatchMerge,
  validateMergeDraft,
  type MergeDraft,
} from './merge.ts';
import type { WorkstreamMergeSender } from './ports.ts';
import { workstreamsStore } from './store.ts';
import { WorkstreamsDeck } from './WorkstreamsDeck.tsx';
import {
  adversarialStrings,
  brief,
  edgeEvent,
  listSnap,
  nodeEvent,
  summary,
  T0,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const goldenMergeFixture = GOLDEN_WS_FIXTURES.find(
  (f): f is GoldenWsTextFixture => f.name === 'workstream-merge-request-valid' && f.kind === 'text',
);
if (goldenMergeFixture === undefined) {
  throw new Error('golden merge fixture missing from the corpus');
}
const GOLDEN_MERGE: GoldenWsTextFixture = goldenMergeFixture;

/** The golden fixture's draft, reconstructed from its pinned wire bytes. */
function goldenDraft(): { draft: MergeDraft; mergeId: string; seq: number } {
  const envelope = JSON.parse(GOLDEN_MERGE.frame) as {
    seq: number;
    payload: WorkstreamMergeRequest;
  };
  const p = envelope.payload.params;
  return {
    draft: {
      parents: p.parents,
      accountLabel: p.accountLabel,
      backend: p.backend,
      cwd: p.cwd,
      purpose: p.purpose,
      briefBody: p.briefBody,
      ...(p.workstreamId !== undefined ? { workstreamId: p.workstreamId } : {}),
    },
    mergeId: envelope.payload.mergeId,
    seq: envelope.seq,
  };
}

class CapturingSender implements WorkstreamMergeSender {
  requests: WorkstreamMergeRequest[] = [];
  connected = true;
  sendWorkstreamMergeRequest(request: WorkstreamMergeRequest): boolean {
    if (!this.connected) return false;
    this.requests.push(request);
    return true;
  }
}

beforeEach(() => {
  workstreamsStore.getState().reset();
});

describe('the frozen envelope (§14 corpus device)', () => {
  it('an encoded merge request is BYTE-identical to the golden frame', () => {
    const { draft, mergeId, seq } = goldenDraft();
    const encoded = encodeEnvelope('workstream', seq, buildMergeRequest(draft, mergeId));
    expect(encoded).toBe(GOLDEN_MERGE.frame);
  });

  it('the golden draft passes the frozen validator verbatim', () => {
    const { draft, mergeId } = goldenDraft();
    const verdict = validateMergeDraft(draft, mergeId);
    expect(verdict.ok).toBe(true);
  });

  it('every invalid client-message corpus fixture is refused with its pinned code', () => {
    // The frozen validator IS what validateMergeDraft delegates to — replay
    // the raw pinned payloads through it, exactly as the broker would.
    const invalid = GOLDEN_WS_FIXTURES.filter(
      (f): f is GoldenWsTextFixture =>
        f.stage === 'workstream-client-message' && f.kind === 'text' && !f.expect.valid,
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const fixture of invalid) {
      const envelope = JSON.parse(fixture.frame) as { payload: unknown };
      const verdict = validateWorkstreamClientMessage(envelope.payload);
      expect(verdict.ok, fixture.name).toBe(false);
      if (!verdict.ok && fixture.expect.valid === false) {
        expect(verdict.code, fixture.name).toBe(fixture.expect.code);
      }
    }
  });
});

describe('dispatchMerge — every ending is an instrument state', () => {
  const baseDraft = (over: Partial<MergeDraft> = {}): MergeDraft => ({
    parents: ['ses_a', 'ses_b'],
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    cwd: '/synthetic/workspace',
    purpose: 'merge test',
    briefBody: 'merge brief: conflicts surfaced explicitly.',
    ...over,
  });

  it('valid draft + live sender ⇒ pending, exactly one frozen request sent', () => {
    const sender = new CapturingSender();
    const outcome = dispatchMerge(baseDraft(), 'mrg_t1', { store: workstreamsStore, sender });
    expect(outcome).toBe('pending');
    expect(sender.requests).toHaveLength(1);
    expect(sender.requests[0]?.kind).toBe('workstream-merge-request');
    expect(sender.requests[0]?.mergeId).toBe('mrg_t1');
    expect(workstreamsStore.getState().merges['mrg_t1']?.phase).toBe('pending');
    expect(workstreamsStore.getState().merges['mrg_t1']?.parents).toEqual(['ses_a', 'ses_b']);
  });

  it('shape violations are BLOCKED client-side and never sent (negative)', () => {
    const sender = new CapturingSender();
    const cases: readonly [string, MergeDraft][] = [
      ['one parent', baseDraft({ parents: ['ses_a'] })],
      ['seventeen parents', baseDraft({ parents: Array.from({ length: 17 }, (_, i) => `ses_${i}`) })],
      ['duplicate parents', baseDraft({ parents: ['ses_a', 'ses_a'] })],
      ['pairing violation', baseDraft({ backend: 'opencode' })],
      ['relative cwd', baseDraft({ cwd: 'relative/path' })],
      ['blank purpose', baseDraft({ purpose: '' })],
      ['blank brief', baseDraft({ briefBody: '' })],
      ['malformed workstreamId', baseDraft({ workstreamId: 'not a segment!' })],
    ];
    cases.forEach(([label, draft], i) => {
      const outcome = dispatchMerge(draft, `mrg_bad_${i}`, { store: workstreamsStore, sender });
      expect(outcome, label).toBe('blocked');
      expect(workstreamsStore.getState().merges[`mrg_bad_${i}`]?.phase, label).toBe('blocked');
      expect(workstreamsStore.getState().merges[`mrg_bad_${i}`]?.code, label).toBe('bad-request');
    });
    expect(sender.requests).toHaveLength(0);
  });

  it('no sender seam ⇒ unsendable, nothing throws (edge)', () => {
    const outcome = dispatchMerge(baseDraft(), 'mrg_t2', {
      store: workstreamsStore,
      sender: undefined,
    });
    expect(outcome).toBe('unsendable');
    expect(workstreamsStore.getState().merges['mrg_t2']?.phase).toBe('unsendable');
  });

  it('wire down (sender returns false) ⇒ unsendable (edge)', () => {
    const sender = new CapturingSender();
    sender.connected = false;
    const outcome = dispatchMerge(baseDraft(), 'mrg_t3', { store: workstreamsStore, sender });
    expect(outcome).toBe('unsendable');
  });

  it('the wire endings land through the store: resolved and each §16.4 code', () => {
    const sender = new CapturingSender();
    dispatchMerge(baseDraft(), 'mrg_ok', { store: workstreamsStore, sender });
    workstreamsStore.getState().applyBatch([
      { kind: 'workstream-merge-resolved', mergeId: 'mrg_ok', sessionId: 'ses_m', briefId: 'br_m' },
    ]);
    expect(workstreamsStore.getState().merges['mrg_ok']?.phase).toBe('resolved');
    expect(workstreamsStore.getState().merges['mrg_ok']?.sessionId).toBe('ses_m');

    for (const code of ['bad-request', 'session-not-found', 'workstream-not-found', 'internal'] as const) {
      const mergeId = `mrg_${code}`;
      dispatchMerge(baseDraft(), mergeId, { store: workstreamsStore, sender });
      workstreamsStore.getState().applyMergeError(mergeId, code);
      expect(workstreamsStore.getState().merges[mergeId]?.phase).toBe('failed');
      expect(workstreamsStore.getState().merges[mergeId]?.code).toBe(code);
    }
  });
});

describe('merge preview — the conflict-surfacing brief seed', () => {
  it('prefers the broker-drafted merge brief for this EXACT parent set', () => {
    const briefs = {
      br_a: brief('br_a', ['ses_a']),
      br_draft: brief('br_draft', ['ses_b', 'ses_a'], {
        briefKind: 'merge',
        provenance: 'local-draft',
        body: 'drafted merge brief: shared goal; conflicts: approach differs.',
      }),
    };
    const preview = assembleMergePreview(['ses_a', 'ses_b'], briefs, ['br_a', 'br_draft']);
    expect(preview.draft?.briefId).toBe('br_draft');
    expect(preview.seededBody).toContain('drafted merge brief');
    // Per-parent distillates ride along (merge-kind briefs excluded there).
    expect(preview.parents[0]?.briefId).toBe('br_a');
    expect(preview.parents[1]?.briefId).toBeUndefined();
  });

  it('without a draft it seeds a scaffold that FORCES the conflict section', () => {
    const preview = assembleMergePreview(['ses_a', 'ses_b'], {}, []);
    expect(preview.draft).toBeUndefined();
    expect(preview.seededBody).toContain('merge brief: 2 parents');
    expect(preview.seededBody).toContain('conflicts:');
    expect(preview.seededBody).toContain('ses_a: NO BRIEF RECORDED');
  });

  it('a draft for a DIFFERENT parent set is not matched (negative)', () => {
    const briefs = {
      br_d: brief('br_d', ['ses_a', 'ses_c'], { briefKind: 'merge' }),
    };
    const preview = assembleMergePreview(['ses_a', 'ses_b'], briefs, ['br_d']);
    expect(preview.draft).toBeUndefined();
  });

  it('masks identity-shaped text in excerpts and the seeded body [X2]', () => {
    const { emailish, awsIdish } = adversarialStrings();
    const briefs = {
      br_a: brief('br_a', ['ses_a'], { body: `first line mailto ${emailish}\nrest` }),
      br_draft: brief('br_draft', ['ses_a', 'ses_b'], {
        briefKind: 'merge',
        body: `merge draft acct ${awsIdish}`,
      }),
    };
    const preview = assembleMergePreview(['ses_a', 'ses_b'], briefs, ['br_a', 'br_draft']);
    expect(preview.parents[0]?.excerpt).not.toContain(emailish);
    expect(preview.parents[0]?.excerpt).toContain('[MASKED]');
    expect(preview.seededBody).not.toContain(awsIdish);
    expect(preview.seededBody).toContain('[MASKED]');
  });
});

describe('deck round-trip: select N nodes → preview → dispatch → new node', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    connectionStore.getState().reset();
  });

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing element ${testId}`);
    act(() => el.click());
  }

  it('dispatches the frozen verb and renders the merge node on resolution', () => {
    const sender = new CapturingSender();
    let mergeSeq = 0;
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap([summary('ws_1', { nodeCount: 2 })], 0),
        nodeEvent('ses_a', { workstreamId: 'ws_1', cwd: '/synthetic/workspace', createdAt: T0 }),
        nodeEvent('ses_b', { workstreamId: 'ws_1', cwd: '/synthetic/workspace', createdAt: T0 + 1 }),
      ]),
    );
    act(() => {
      root.render(
        <WorkstreamsDeck
          sender={sender}
          newMergeId={() => {
            mergeSeq += 1;
            return `mrg_deck_${mergeSeq}`;
          }}
        />,
      );
    });

    // Select the two leaves (selection is an instrument affordance).
    click('ws-node-ses_a');
    click('ws-node-ses_b');
    expect(host.querySelector('[data-testid="ws-merge-state"]')?.textContent).toBe('2 SELECTED');
    expect(host.querySelector('[data-testid="ws-merge-parent-ses_a"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="ws-merge-parent-ses_b"]')).not.toBeNull();

    // Seed the conflict-surfacing scaffold, then fill the purpose.
    click('ws-merge-seed');
    const briefEditor = host.querySelector<HTMLTextAreaElement>('[data-testid="ws-merge-brief"]');
    expect(briefEditor?.value).toContain('conflicts:');
    const purpose = host.querySelector<HTMLInputElement>('[data-testid="ws-merge-purpose"]');
    if (purpose === null) throw new Error('missing purpose input');
    act(() => setNativeValue(purpose, 'converge the two branches'));
    // cwd pre-filled from the first selected node.
    expect(host.querySelector<HTMLInputElement>('[data-testid="ws-merge-cwd"]')?.value).toBe(
      '/synthetic/workspace',
    );

    click('ws-merge-dispatch');
    expect(sender.requests).toHaveLength(1);
    const request = sender.requests[0];
    expect(request?.params.parents).toEqual(['ses_a', 'ses_b']);
    expect(request?.params.workstreamId).toBe('ws_1');
    expect(request?.params.briefBody).toContain('conflicts:');
    expect(host.querySelector('[data-testid="ws-merge-state"]')?.textContent).toBe('PENDING');

    // The broker fans out the resolution + the node/edge upserts (§16.3).
    act(() =>
      workstreamsStore.getState().applyBatch([
        {
          kind: 'workstream-merge-resolved',
          mergeId: 'mrg_deck_1',
          sessionId: 'ses_m',
          briefId: 'br_m',
        },
        nodeEvent('ses_m', { workstreamId: 'ws_1', createdAt: T0 + 10 }),
        edgeEvent('edg_m1', 'ses_a', 'ses_m', { edgeType: 'merge_parent', ts: T0 + 10 }),
        edgeEvent('edg_m2', 'ses_b', 'ses_m', { edgeType: 'merge_parent', ts: T0 + 11 }),
      ]),
    );
    expect(host.querySelector('[data-testid="ws-merge-state"]')?.textContent).toBe(
      'RESOLVED → ses_m',
    );
    const mergeRow = host.querySelector('[data-testid="ws-node-ses_m"]');
    expect(mergeRow).not.toBeNull();
    expect(mergeRow?.getAttribute('data-merge')).toBe('true');
    expect(
      host.querySelector('[data-testid="ws-merge-badge-ses_m"]')?.textContent,
    ).toBe('MERGE ×2');
    // Both merge_parent rails render.
    expect(host.querySelector('[data-testid="ws-edge-edg_m1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="ws-edge-edg_m2"]')).not.toBeNull();
  });

  it('a blocked dispatch renders the fault register, nothing is sent (negative)', () => {
    const sender = new CapturingSender();
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap([summary('ws_1')], 0),
        nodeEvent('ses_a', { workstreamId: 'ws_1', cwd: '/synthetic/workspace' }),
      ]),
    );
    act(() => {
      root.render(<WorkstreamsDeck sender={sender} newMergeId={() => 'mrg_solo'} />);
    });
    click('ws-node-ses_a'); // one parent — below the frozen 2..16 floor
    click('ws-merge-seed');
    const purpose = host.querySelector<HTMLInputElement>('[data-testid="ws-merge-purpose"]');
    if (purpose === null) throw new Error('missing purpose input');
    act(() => setNativeValue(purpose, 'solo'));
    click('ws-merge-dispatch');
    expect(sender.requests).toHaveLength(0);
    expect(host.querySelector('[data-testid="ws-merge-state"]')?.textContent).toBe(
      'BLOCKED · bad-request',
    );
    expect(
      host.querySelector('[data-testid="ws-merge-panel"]')?.getAttribute('data-status'),
    ).toBe('fault');
  });

  it('without a sender the dispatch renders NOT CONNECTED (unsendable, edge)', () => {
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap([summary('ws_1')], 0),
        nodeEvent('ses_a', { workstreamId: 'ws_1', cwd: '/synthetic/workspace' }),
        nodeEvent('ses_b', { workstreamId: 'ws_1', cwd: '/synthetic/workspace' }),
      ]),
    );
    act(() => {
      root.render(<WorkstreamsDeck newMergeId={() => 'mrg_nosender'} />);
    });
    click('ws-node-ses_a');
    click('ws-node-ses_b');
    click('ws-merge-seed');
    const purpose = host.querySelector<HTMLInputElement>('[data-testid="ws-merge-purpose"]');
    if (purpose === null) throw new Error('missing purpose input');
    act(() => setNativeValue(purpose, 'unsendable path'));
    click('ws-merge-dispatch');
    expect(host.querySelector('[data-testid="ws-merge-state"]')?.textContent).toBe('NOT CONNECTED');
    expect(
      host.querySelector('[data-testid="ws-merge-panel"]')?.getAttribute('data-status'),
    ).toBe('nosignal');
  });
});
