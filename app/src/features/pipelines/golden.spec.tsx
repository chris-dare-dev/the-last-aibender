// @vitest-environment jsdom
/**
 * Golden-fixture-driven pipeline rendering (plan §9.2 FE-6 positive row; the
 * corpus is the contract device, §14). Every FROZEN-M5 `pipelines-payload`
 * fixture is routed through the REAL FE inbound router; the valid set must
 * hydrate the deck (catalog palette + run monitor + verb correlation); every
 * invalid fixture must be dropped with its pinned code before it can touch the
 * store; unknown kinds decode opaque and are ignored (the frozen
 * forward-tolerant reader rule).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OpaquePipelinePayload, PipelineServerPayload } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { approvalsStore, connectionStore, routeBrokerFrame } from '../../lib/index.ts';
import { pipelinesStore } from './store.ts';
import { PipelinesDeck } from './PipelinesDeck.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIPELINE_FIXTURES = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsTextFixture =>
    f.stage === 'pipelines-payload' && f.kind === 'text' && f.direction === 'broker-to-client',
);

function decodePayload(frame: string): PipelineServerPayload | OpaquePipelinePayload | undefined {
  const verdict = routeBrokerFrame(frame);
  if (!verdict.ok || verdict.message.kind !== 'pipelines') return undefined;
  return verdict.message.payload;
}

describe('golden pipelines corpus → deck', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    pipelinesStore.getState().reset();
    approvalsStore.getState().reset();
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
      root.render(<PipelinesDeck />);
    });
  }

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing element ${testId}`);
    act(() => el.click());
  }

  function hydrateFromCorpus(): void {
    const payloads: PipelineServerPayload[] = [];
    for (const fixture of PIPELINE_FIXTURES) {
      if (!fixture.expect.valid) continue;
      const payload = decodePayload(fixture.frame);
      if (payload === undefined || 'opaque' in payload) continue;
      payloads.push(payload);
    }
    act(() => pipelinesStore.getState().applyBatch(payloads));
  }

  it('hydrates the builder palette from the corpus catalog snapshot', () => {
    hydrateFromCorpus();
    renderDeck();
    // The corpus catalog is scoped to /synthetic/workspace; select that scope.
    // A single-workspace snapshot resolves via the workspace picker OR global
    // fallback — the palette shows the write-report skill either way.
    const readout = host.querySelector('[data-testid="pl-palette-readout"]')?.textContent ?? '';
    // The corpus has exactly one entry (write-report, well-formed → 0 DEG).
    expect(readout).toContain('CAP');
    // The skill group carries the entry.
    expect(host.querySelector('[data-testid="pl-cap-cap_fake_1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pl-cap-cap_fake_1"]')?.textContent).toContain(
      'write-report',
    );
  });

  it('hydrates the run monitor from the corpus run snapshot (memoized = cached)', () => {
    // Hydrate ONLY the run-snapshot fixture: the run-status fixture targets the
    // same runId with a later `completed` transition, which (correctly) would
    // supersede the snapshot's running+resumable state. This asserts the
    // snapshot's settled journal render in isolation (the subscribe scenario).
    const snap = PIPELINE_FIXTURES.find((f) => f.name === 'pipelines-run-snapshot-valid');
    const payload = snap === undefined ? undefined : decodePayload(snap.frame);
    if (payload === undefined || 'opaque' in payload) throw new Error('snapshot fixture missing');
    act(() => pipelinesStore.getState().applyBatch([payload]));
    renderDeck();
    click('pl-mode-monitor');
    // The corpus run is running + resumable with one memoized step.
    expect(host.querySelector('[data-testid="pl-run-run_fake_1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pl-run-resumable-run_fake_1"]')?.textContent).toBe(
      'RESUMABLE',
    );
    click('pl-run-run_fake_1');
    const step = host.querySelector('[data-testid="pl-run-step-a-0-0"]');
    expect(step).not.toBeNull();
    // MEMOIZED = resumed-from-journal cache hit, rendered settled (never animated).
    expect(step?.getAttribute('data-state')).toBe('memoized');
    expect(host.querySelector('[data-testid="pl-run-state-a"]')?.textContent).toBe('MEMOIZED');
    // per-step cost from the events-store-fed payload
    expect(host.querySelector('[data-testid="pl-run-cost-a"]')?.textContent).toContain('EST');
    // the step's account renders (the [X1] routing chip)
    expect(host.querySelector('[data-testid="pl-run-step-account-a"]')?.getAttribute('data-account')).toBe(
      'MAX_A',
    );
  });

  it('lands the corpus validation-result + saved ack in the verb table', () => {
    // Pre-track the verbs so the answers correlate to a known dispatch.
    pipelinesStore.getState().trackVerb({
      requestId: 'req_v1',
      verb: 'pipeline-validate',
      phase: 'pending',
    });
    pipelinesStore.getState().trackVerb({
      requestId: 'req_s1',
      verb: 'pipeline-save',
      phase: 'pending',
    });
    hydrateFromCorpus();
    const verbs = pipelinesStore.getState().verbs;
    expect(verbs['req_v1']?.valid).toBe(false);
    expect(verbs['req_v1']?.issueCode).toBe('cycle');
    expect(verbs['req_s1']?.pipelineId).toBe('wf_fake_1');
  });

  it('every invalid corpus fixture is dropped before the store (negative)', () => {
    for (const fixture of PIPELINE_FIXTURES) {
      if (fixture.expect.valid) continue;
      const verdict = routeBrokerFrame(fixture.frame);
      expect(verdict.ok, fixture.name).toBe(false);
      if (!verdict.ok && fixture.expect.valid === false) {
        expect(verdict.code, fixture.name).toBe(fixture.expect.code);
        expect(verdict.stage, fixture.name).toBe('pipelines-payload');
      }
    }
    expect(pipelinesStore.getState().runs).toEqual({});
    expect(pipelinesStore.getState().catalog).toEqual({});
  });

  it('unknown kinds decode opaque and are ignored (frozen tolerant-reader rule)', () => {
    const tolerated = PIPELINE_FIXTURES.find((f) => f.name === 'pipelines-unknown-kind-tolerated');
    expect(tolerated).toBeDefined();
    const payload = decodePayload((tolerated as GoldenWsTextFixture).frame);
    expect(payload).toBeDefined();
    expect(payload !== undefined && 'opaque' in payload).toBe(true);
  });

  it('a down gateway renders NO SIGNAL panels, slots retained (negative)', () => {
    hydrateFromCorpus();
    connectionStore.getState().setPhase('no-broker');
    renderDeck();
    const readouts = [...host.querySelectorAll('[data-testid="pl-nosignal"]')];
    expect(readouts).toHaveLength(3);
    expect(readouts.every((r) => r.textContent === 'NO SIGNAL')).toBe(true);
    expect(host.querySelector('[data-testid="pl-palette"]')).toBeNull();
  });
});
