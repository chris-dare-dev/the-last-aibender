// @vitest-environment jsdom
/**
 * Golden-fixture-driven dashboard rendering (plan §9.2 FE-5 positive row:
 * "gauges match store fixtures numerically"; the corpus is the contract
 * device). Every FROZEN-M3 `events-payload` fixture is routed through the
 * REAL FE inbound router; every valid read-model snapshot must render its
 * instrument with the fixture's numbers; every invalid fixture must be
 * dropped before it can touch the store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReadModelSnapshot } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { connectionStore, quotaStore, routeBrokerFrame } from '../../lib/index.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { observabilityStore } from './store.ts';
import { T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EVENTS_FIXTURES = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsTextFixture => f.stage === 'events-payload' && f.kind === 'text',
);

/** Route a fixture frame exactly like the live client and return the payload. */
function decodeEventsPayload(frame: string): ReadModelSnapshot | undefined {
  const verdict = routeBrokerFrame(frame);
  if (!verdict.ok || verdict.message.kind !== 'events') return undefined;
  const payload = verdict.message.payload;
  if ('opaque' in payload || payload.kind !== 'read-model-snapshot') return undefined;
  return payload;
}

describe('golden events corpus → deck rendering', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    observabilityStore.getState().reset();
    quotaStore.getState().reset();
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
      root.render(<ObservabilityDeck now={() => T0} />);
    });
  }

  function textOf(testId: string): string {
    return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
  }

  it('hydrates the whole deck from the valid corpus fixtures', () => {
    const snapshots: ReadModelSnapshot[] = [];
    for (const fixture of EVENTS_FIXTURES) {
      const payload = decodeEventsPayload(fixture.frame);
      if (payload !== undefined) snapshots.push(payload);
    }
    // The M3 corpus carries exactly one valid fixture per §6.3 read model.
    expect(new Set(snapshots.map((s) => s.readModel)).size).toBe(10);
    act(() => observabilityStore.getState().applyBatch(snapshots));
    renderDeck();

    // 1 · QUOTA — 41.5% gauge; 100% with resetsAt in the past reads DUE+FAULT.
    expect(textOf('quota-MAX_A-5h')).toContain('41.5%');
    expect(textOf('quota-MAX_B-7d')).toContain('100.0%');
    expect(textOf('quota-MAX_B-7d')).toContain('R DUE');
    expect(textOf('readout-quota-gauges')).toBe('FAULT');

    // 2 · BURN RATE — ccusage block math renders rate + projected exhaustion.
    expect(textOf('burn-MAX_A')).toContain('120.0K/H');
    expect(textOf('burn-MAX_A')).toContain('EXH 3H51M');

    // 3 · BEDROCK — estimate-only: the estimate renders, honestly labeled.
    expect(textOf('bedrock-estimate')).toContain('$12.50');
    expect(textOf('bedrock-estimate')).toContain('ESTIMATE');
    expect(host.querySelector('[data-testid="bedrock-actual"]')).toBeNull();

    // 4 · API-EQUIV — equivalence, never spend.
    expect(textOf('equiv-ENT')).toContain('$42.00');
    expect(textOf('instrument-api-equivalent-usd')).toContain('EQUIVALENCE · NOT SPEND · 7D');

    // 5 · CACHE HIT — TTL split visible.
    expect(textOf('cache-MAX_A')).toContain('87.5%');
    expect(textOf('cache-MAX_A')).toContain('5M 4.0K');
    expect(textOf('cache-MAX_A')).toContain('1H 6.0K');

    // 6 · LATENCY — p50/p95 + TTFT.
    expect(textOf('latency-lmstudio')).toContain('300MS');
    expect(textOf('latency-lmstudio')).toContain('900MS');
    expect(textOf('latency-lmstudio')).toContain('TTFT 80MS/200MS');
    expect(textOf('latency-lmstudio')).toContain('N40');

    // 7 · ERR/THROTTLE — counters + stale source degrades the instrument.
    expect(textOf('health-opencode-sse')).toContain('ERR 1');
    expect(textOf('health-opencode-sse')).toContain('RTY 2');
    expect(textOf('readout-health')).toBe('DEGRADED');

    // 8 · SKILLS — correction rate absent until the local-model job ran.
    expect(textOf('skill-synthetic-skill')).toContain('×12');
    expect(textOf('skill-synthetic-skill')).toContain('75.0%');
    expect(textOf('skill-synthetic-skill')).toContain('CORR —');
    expect(host.querySelector('[data-testid="worst-quartile-flag"]')).toBeNull();

    // 9 · OUTCOMES — insights facet mix.
    expect(textOf('outcome-completed')).toContain('9');

    // 10 · LOCAL OFFLOAD — lmstudio-down is a STATE: instrument dims to
    // NO SIGNAL, data stays engraved, remediation affordance offered.
    expect(textOf('readout-local-offload')).toBe('NO SIGNAL');
    expect(textOf('offload-ratio')).toContain('22.2%');
    expect(
      host.querySelector('[data-instrument="local-offload"]')?.getAttribute('data-status'),
    ).toBe('nosignal');
    expect(
      host.querySelector('[data-remediation="lms server start"]')?.textContent,
    ).toBe('LMS SERVER START');
  });

  it('every invalid corpus fixture is dropped before the store (negative)', () => {
    for (const fixture of EVENTS_FIXTURES) {
      if (fixture.expect.valid) continue;
      const verdict = routeBrokerFrame(fixture.frame);
      expect(verdict.ok, fixture.name).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe(fixture.expect.code);
    }
    expect(observabilityStore.getState().snapshots).toEqual({});
    renderDeck();
    // Nothing landed → every §6.3 instrument reads NO SIGNAL, slots retained.
    const readouts = [...host.querySelectorAll('[data-instrument]')].map((el) =>
      el.querySelector('.ig-panel-readout')?.textContent,
    );
    expect(readouts).toHaveLength(10);
    expect(readouts.every((r) => r === 'NO SIGNAL')).toBe(true);
  });

  it('unknown kinds decode opaque and are ignored (frozen tolerant-reader rule)', () => {
    const tolerated = EVENTS_FIXTURES.filter(
      (f) =>
        f.expect.valid &&
        (f.name === 'events-broker-payload-draft-opaque' || f.name === 'events-unknown-kind-tolerated'),
    );
    expect(tolerated).toHaveLength(2);
    for (const fixture of tolerated) {
      const verdict = routeBrokerFrame(fixture.frame);
      expect(verdict.ok).toBe(true);
      expect(decodeEventsPayload(fixture.frame)).toBeUndefined();
    }
  });

  it('instruments render in the frozen §6.3 order, data never reorders them (edge)', () => {
    renderDeck();
    const before = [...host.querySelectorAll('[data-instrument]')].map((el) =>
      el.getAttribute('data-instrument'),
    );
    const snapshots: ReadModelSnapshot[] = [];
    for (const fixture of [...EVENTS_FIXTURES].reverse()) {
      const payload = decodeEventsPayload(fixture.frame);
      if (payload !== undefined) snapshots.push(payload);
    }
    act(() => observabilityStore.getState().applyBatch(snapshots));
    const after = [...host.querySelectorAll('[data-instrument]')].map((el) =>
      el.getAttribute('data-instrument'),
    );
    expect(before).toEqual([
      'quota-gauges',
      'burn-rate',
      'bedrock-cost',
      'api-equivalent-usd',
      'cache-hit-rate',
      'latency',
      'health',
      'skill-leaderboard',
      'session-outcomes',
      'local-offload',
    ]);
    expect(after).toEqual(before);
  });
});
