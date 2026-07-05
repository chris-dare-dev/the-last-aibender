// @vitest-environment jsdom
/**
 * Golden-fixture-driven lineage rendering (plan §9.2 FE-6 positive row; the
 * corpus is the contract device, §14). Every FROZEN-M4 `workstream-payload`
 * fixture is routed through the REAL FE inbound router; the valid set must
 * hydrate the deck (rail, lineage graph, detached-HEAD bucket, brief viewer,
 * advisory strip, merge correlation); every invalid fixture must be dropped
 * with its pinned code before it can touch the store; unknown kinds decode
 * opaque and are ignored (the frozen forward-tolerant reader rule).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OpaqueWorkstreamPayload, WorkstreamServerPayload } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { connectionStore, routeBrokerFrame } from '../../lib/index.ts';
import { workstreamsStore } from './store.ts';
import { WorkstreamsDeck } from './WorkstreamsDeck.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSTREAM_FIXTURES = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsTextFixture =>
    f.stage === 'workstream-payload' && f.kind === 'text' && f.direction === 'broker-to-client',
);

/** Route a fixture frame exactly like the live client and return the payload. */
function decodeWorkstreamPayload(
  frame: string,
): WorkstreamServerPayload | OpaqueWorkstreamPayload | undefined {
  const verdict = routeBrokerFrame(frame);
  if (!verdict.ok || verdict.message.kind !== 'workstream') return undefined;
  return verdict.message.payload;
}

describe('golden workstream corpus → lineage deck', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    workstreamsStore.getState().reset();
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

  function renderDeck(): void {
    act(() => {
      root.render(<WorkstreamsDeck />);
    });
  }

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing element ${testId}`);
    act(() => el.click());
  }

  function hydrateFromCorpus(): void {
    const payloads: WorkstreamServerPayload[] = [];
    for (const fixture of WORKSTREAM_FIXTURES) {
      if (!fixture.expect.valid) continue;
      const payload = decodeWorkstreamPayload(fixture.frame);
      if (payload === undefined || 'opaque' in payload) continue;
      payloads.push(payload);
    }
    act(() => workstreamsStore.getState().applyBatch(payloads));
  }

  it('hydrates the rail, the graph and the detached bucket from the corpus', () => {
    hydrateFromCorpus();
    renderDeck();

    // The rail: one workstream + one detached-HEAD orphan.
    expect(host.querySelector('[data-testid="ws-rail-readout"]')?.textContent).toBe(
      '1 WS · 1 DET',
    );
    const railRow = host.querySelector('[data-testid="ws-rail-ws_golden"]');
    expect(railRow?.textContent).toContain('golden workstream');
    expect(railRow?.textContent).toContain('ACTIVE');

    // Default scope = the first workstream on the rail.
    expect(host.querySelector('[data-testid="ws-lineage-readout"]')?.textContent).toBe(
      'ws_golden',
    );
    const node = host.querySelector('[data-testid="ws-node-ses_fake_1"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('data-confidence')).toBe('recorded');
    expect(host.querySelector('[data-testid="ws-conf-ses_fake_1"]')?.textContent).toBe('REC');
    expect(node?.textContent).toContain('MAX_A');
    expect(node?.textContent).toContain('RUNNING');

    // The detached-HEAD bucket: the reconciled orphan renders in the
    // inferred-confidence register — dimmed register + INF text, never
    // color-only (DESIGN.md §9).
    click('ws-rail-detached');
    expect(host.querySelector('[data-testid="ws-lineage-readout"]')?.textContent).toBe(
      'DETACHED HEAD',
    );
    const orphan = host.querySelector('[data-testid="ws-node-ses_fake_ext"]');
    expect(orphan).not.toBeNull();
    expect(orphan?.getAttribute('data-confidence')).toBe('inferred');
    expect(orphan?.getAttribute('data-origin')).toBe('reconciled');
    expect(orphan?.getAttribute('data-state')).toBe('external');
    expect(host.querySelector('[data-testid="ws-conf-ses_fake_ext"]')?.textContent).toBe('INF');
    // The recorded node does NOT render in the detached bucket.
    expect(host.querySelector('[data-testid="ws-node-ses_fake_1"]')).toBeNull();
  });

  it('renders the brief viewer from the corpus brief (session-end, native-summary)', () => {
    hydrateFromCorpus();
    renderDeck();
    click('ws-node-ses_fake_1'); // focus the node the brief distills
    expect(host.querySelector('[data-testid="ws-brief-readout"]')?.textContent).toBe(
      'SESSION-END · NATIVE-SUMMARY',
    );
    expect(host.querySelector('[data-testid="ws-brief-body"]')?.textContent).toContain(
      'continuation brief',
    );
  });

  it('surfaces the corpus branch advisory as a dismissible instrument state', () => {
    hydrateFromCorpus();
    renderDeck();
    const advisory = host.querySelector('[data-testid="ws-advisory-ses_fake_1"]');
    expect(advisory).not.toBeNull();
    expect(advisory?.textContent).toContain('BRANCH NOW');
    expect(advisory?.textContent).toContain('71.5% CTX');
    // Dismiss: the instrument clears — and STAYS cleared for the same ts.
    click('ws-advisory-dismiss-ses_fake_1');
    expect(host.querySelector('[data-testid="ws-advisory-ses_fake_1"]')).toBeNull();
  });

  it('lands the corpus merge resolution in the correlation table', () => {
    hydrateFromCorpus();
    expect(workstreamsStore.getState().merges['mrg_01']).toEqual({
      mergeId: 'mrg_01',
      phase: 'resolved',
      sessionId: 'ses_fake_3',
      briefId: 'br_fake_2',
    });
  });

  it('every invalid corpus fixture is dropped before the store (negative)', () => {
    for (const fixture of WORKSTREAM_FIXTURES) {
      if (fixture.expect.valid) continue;
      const verdict = routeBrokerFrame(fixture.frame);
      expect(verdict.ok, fixture.name).toBe(false);
      if (!verdict.ok && fixture.expect.valid === false) {
        expect(verdict.code, fixture.name).toBe(fixture.expect.code);
        expect(verdict.stage, fixture.name).toBe('workstream-payload');
      }
    }
    expect(workstreamsStore.getState().nodes).toEqual({});
    expect(workstreamsStore.getState().rail).toBeUndefined();
  });

  it('unknown kinds decode opaque and are ignored (frozen tolerant-reader rule)', () => {
    const tolerated = WORKSTREAM_FIXTURES.find(
      (f) => f.name === 'workstream-unknown-kind-tolerated',
    );
    expect(tolerated).toBeDefined();
    const payload = decodeWorkstreamPayload((tolerated as GoldenWsTextFixture).frame);
    expect(payload).toBeDefined();
    expect(payload !== undefined && 'opaque' in payload).toBe(true);
  });

  it('a down gateway renders NO SIGNAL panels, slots retained (negative)', () => {
    hydrateFromCorpus();
    connectionStore.getState().setPhase('no-broker');
    renderDeck();
    const readouts = [...host.querySelectorAll('[data-testid="ws-nosignal"]')];
    expect(readouts).toHaveLength(3);
    expect(readouts.every((r) => r.textContent === 'NO SIGNAL')).toBe(true);
    expect(host.querySelector('[data-testid="ws-graph"]')).toBeNull();
  });
});
