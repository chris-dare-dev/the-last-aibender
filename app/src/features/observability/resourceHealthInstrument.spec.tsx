// @vitest-environment jsdom
/**
 * ResourceHealthInstrument rendering (plan §9.2 FE M6 positive/negative/edge).
 *
 * The golden corpus is the BE↔FE contract device: every FROZEN-M6
 * `events-payload` resource-health fixture is routed through the REAL FE
 * inbound router; the valid ones must render the supervision instrument with
 * the fixture's numbers; the invalid ones must be dropped before they reach
 * the store. Core doctrine under test: a shed/recycle renders as an
 * instrument STATE row, NEVER a toast (ws-protocol.md §13.4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReadModelSnapshot } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { connectionStore, routeBrokerFrame } from '../../lib/index.ts';
import { ResourceHealthInstrument } from './ResourceHealthInstrument.tsx';
import { observabilityStore } from './store.ts';
import { resourceHealthSnap, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RH_FIXTURES = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsTextFixture =>
    f.stage === 'events-payload' && f.kind === 'text' && f.name.includes('resource-health'),
);

function decodeEventsPayload(frame: string): ReadModelSnapshot | undefined {
  const verdict = routeBrokerFrame(frame);
  if (!verdict.ok || verdict.message.kind !== 'events') return undefined;
  const payload = verdict.message.payload;
  if ('opaque' in payload || payload.kind !== 'read-model-snapshot') return undefined;
  return payload;
}

describe('ResourceHealthInstrument — golden corpus rendering', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    observabilityStore.getState().reset();
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

  function render(): void {
    act(() => {
      root.render(<ResourceHealthInstrument now={() => T0 + 1000} />);
    });
  }

  function textOf(testId: string): string {
    return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
  }

  it('the corpus carries exactly one valid + several invalid fixtures', () => {
    const valid = RH_FIXTURES.filter((f) => f.expect.valid);
    // min-valid + full-valid are the two valid frames.
    expect(valid.map((f) => f.name).sort()).toEqual([
      'events-readmodel-resource-health-full-valid',
      'events-readmodel-resource-health-min-valid',
    ]);
    // Every invalid class is present.
    expect(RH_FIXTURES.filter((f) => !f.expect.valid).length).toBeGreaterThanOrEqual(8);
  });

  it('renders the full-valid red-pressure snapshot with the sacrifice order (positive)', () => {
    const full = RH_FIXTURES.find((f) => f.name.endsWith('full-valid'));
    const payload = decodeEventsPayload(full?.frame ?? '');
    expect(payload?.readModel).toBe('resource-health');
    act(() => observabilityStore.getState().applyBatch([payload as ReadModelSnapshot]));
    render();

    // Instrument (never a toast): a section with the readout STATE.
    expect(host.querySelector('[data-instrument="resource-health"]')).not.toBeNull();
    // lmstudio-down freshness → the instrument reads NO SIGNAL (freshness
    // wins over the red data — never a fabricated FAULT on a dead feed).
    expect(textOf('readout-resource-health')).toBe('NO SIGNAL');
    expect(
      host.querySelector('[data-instrument="resource-health"]')?.getAttribute('data-status'),
    ).toBe('nosignal');

    // Pressure block is engraved from the wire numbers.
    expect(textOf('pressure-level')).toBe('L4');
    expect(textOf('pressure-detail')).toContain('FREE 9.5%');
    expect(textOf('pressure-detail')).toContain('SWAP 26.0GB');
    expect(textOf('pressure-detail')).toContain('RES 3');

    // Per-session footprints: labels + numbers only, bands engraved.
    expect(textOf('rh-session-MAX_A-1')).toContain('CLAUDE #1');
    expect(textOf('rh-session-MAX_A-1')).toContain('3.1GB');
    expect(textOf('rh-session-MAX_A-1')).toContain('WARN');
    expect(textOf('rh-session-LOCAL-0')).toContain('HIBERNATED');

    // Shed/recycle notices render as STATE rows — never an error/toast.
    expect(host.querySelector('[data-testid="rh-notice-shed-local-model"]')).not.toBeNull();
    expect(textOf('rh-notice-shed-local-model')).toContain('SHED LOCAL MODEL');
    expect(textOf('rh-notice-shed-local-model')).toContain('MACHINE');
    const recycle = host.querySelector('[data-testid="rh-notice-recycle-session"]');
    expect(recycle).not.toBeNull();
    expect(recycle?.getAttribute('data-recycle')).toBe('true');
    expect(recycle?.textContent).toContain('MAX_A CLAUDE');

    // No alarm/toast element ever appears (the doctrine): the surface is a
    // single instrument section, and no element carries a toast/alert role.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll('section[data-instrument="resource-health"]')).toHaveLength(1);
  });

  it('renders the min-valid healthy baseline as OK with no sessions (positive)', () => {
    const min = RH_FIXTURES.find((f) => f.name.endsWith('min-valid'));
    const payload = decodeEventsPayload(min?.frame ?? '');
    act(() => observabilityStore.getState().applyBatch([payload as ReadModelSnapshot]));
    render();
    expect(textOf('readout-resource-health')).toBe('OK');
    expect(textOf('pressure-level')).toBe('L0');
    expect(host.querySelector('[data-testid="rh-no-sessions"]')?.textContent).toContain(
      'NO RESIDENT SESSIONS',
    );
    expect(host.querySelector('[data-testid="rh-notices"]')).toBeNull();
  });

  it('every invalid corpus fixture is dropped before the store (negative)', () => {
    for (const fixture of RH_FIXTURES) {
      if (fixture.expect.valid) continue;
      const verdict = routeBrokerFrame(fixture.frame);
      expect(verdict.ok, fixture.name).toBe(false);
      if (!verdict.ok) expect(verdict.code, fixture.name).toBe(fixture.expect.code);
    }
    expect(observabilityStore.getState().snapshots['resource-health']).toBeUndefined();
    render();
    // No snapshot → the instrument reads NO SIGNAL, slot retained.
    expect(textOf('readout-resource-health')).toBe('NO SIGNAL');
    expect(host.querySelector('[data-instrument="resource-health"]')).not.toBeNull();
  });

  it('an absent snapshot renders NO SIGNAL — never a fabricated zero (negative)', () => {
    render();
    expect(textOf('readout-resource-health')).toBe('NO SIGNAL');
    expect(host.querySelector('[data-testid="pressure-gauge"]')).toBeNull();
    // No fabricated pressure numbers when nothing landed.
    expect(host.textContent).not.toContain('L0');
  });

  it('a down gateway dims the instrument to NO SIGNAL, slot retained (negative)', () => {
    act(() => observabilityStore.getState().applyBatch([resourceHealthSnap([src('fresh', 'lmstudio', T0)])]));
    act(() => connectionStore.getState().setPhase('no-broker'));
    render();
    expect(textOf('readout-resource-health')).toBe('NO SIGNAL');
    expect(
      host.querySelector('[data-instrument="resource-health"]')?.getAttribute('data-status'),
    ).toBe('nosignal');
    expect(host.querySelector('.ig-panel-detail')?.textContent).toBe('NO GATEWAY');
  });
});
