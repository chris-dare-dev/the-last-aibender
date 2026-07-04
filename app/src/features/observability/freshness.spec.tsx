// @vitest-environment jsdom
/**
 * NO SIGNAL doctrine across EVERY frozen freshness state (plan §9.2 FE-5
 * negative row; DESIGN.md §2.4): degraded sources are dimmed engraved
 * states with copy-command remediation affordances — never error toasts,
 * never fabricated zeros. Also covers: gauges at 100% with resets_at in the
 * past (edge row), gateway-down dimming, and the copy affordance wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SOURCE_FRESHNESS_STATES, type SourceFreshnessState } from '@aibender/protocol';
import { connectionStore, quotaStore } from '../../lib/index.ts';
import { deriveInstrumentHealth, remediationFor } from './freshness.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { observabilityStore } from './store.ts';
import { quotaGaugesSnap, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXPECTED_READOUT: Record<SourceFreshnessState, string> = {
  fresh: 'OK',
  stale: 'DEGRADED',
  'estimate-only': 'ESTIMATE',
  'no-signal': 'NO SIGNAL',
  'lmstudio-down': 'NO SIGNAL',
  'cluster-absent': 'NO SIGNAL',
  'sso-expired': 'NO SIGNAL',
  'account-logged-out': 'NO SIGNAL',
};

const EXPECTED_REMEDIATION: Partial<Record<SourceFreshnessState, string>> = {
  'lmstudio-down': 'lms server start',
  'sso-expired': 'aws sso login',
  'account-logged-out': 'claude /login',
};

describe('deriveInstrumentHealth (selectors)', () => {
  it('maps every frozen freshness state to the doctrine readout', () => {
    for (const state of SOURCE_FRESHNESS_STATES) {
      const health = deriveInstrumentHealth([src(state)]);
      expect(`${state}:${health.readout}`).toBe(`${state}:${EXPECTED_READOUT[state]}`);
    }
  });

  it('a fresh source keeps partial signal alive; strip lists the degraded one', () => {
    const health = deriveInstrumentHealth([src('fresh'), src('sso-expired', 'bedrock-cloudwatch')]);
    expect(health.status).toBe('degraded');
    expect(health.strip).toHaveLength(1);
    expect(health.strip[0]?.source).toBe('bedrock-cloudwatch');
    expect(health.strip[0]?.remediation?.command).toBe('aws sso login');
  });

  it('remediations exist exactly for the owner-actionable states', () => {
    for (const state of SOURCE_FRESHNESS_STATES) {
      expect(remediationFor(state)?.command).toBe(EXPECTED_REMEDIATION[state]);
    }
  });
});

describe('deck NO SIGNAL rendering per freshness state', () => {
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

  function renderDeck(copyText?: (text: string) => void): void {
    act(() => {
      root.render(
        <ObservabilityDeck now={() => T0} {...(copyText !== undefined ? { copyText } : {})} />,
      );
    });
  }

  function instrument(): Element | null {
    return host.querySelector('[data-instrument="quota-gauges"]');
  }

  it.each([...SOURCE_FRESHNESS_STATES])('renders the %s state per doctrine', (state) => {
    act(() =>
      observabilityStore
        .getState()
        .applyBatch([quotaGaugesSnap([src(state, 'claude-quota', T0 - 1000)])]),
    );
    renderDeck();
    const readout = host.querySelector('[data-testid="readout-quota-gauges"]');
    expect(readout?.textContent).toBe(EXPECTED_READOUT[state]);

    if (EXPECTED_READOUT[state] === 'NO SIGNAL') {
      // Dimmed instrument, slot retained, never an error element.
      expect(instrument()?.getAttribute('data-status')).toBe('nosignal');
    }
    if (state !== 'fresh') {
      // The degraded source renders as an engraved state entry.
      const strip = host.querySelector('[data-testid="sources-quota-gauges"]');
      expect(strip?.textContent).toContain('claude-quota');
    }
    const command = EXPECTED_REMEDIATION[state];
    const button = host.querySelector('[data-remediation]');
    if (command !== undefined) {
      expect(button?.getAttribute('data-remediation')).toBe(command);
    } else {
      expect(button).toBeNull();
    }
  });

  it('the remediation affordance COPIES the command (one-click, owner-run)', () => {
    act(() =>
      observabilityStore.getState().applyBatch([quotaGaugesSnap([src('lmstudio-down', 'lmstudio')])]),
    );
    const copied: string[] = [];
    renderDeck((text) => copied.push(text));
    const button = host.querySelector<HTMLButtonElement>('[data-remediation="lms server start"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(copied).toEqual(['lms server start']);
    expect(button?.textContent).toBe('COPIED');
  });

  it('an absent read model renders NO SIGNAL — never a fabricated zero (negative)', () => {
    renderDeck();
    expect(host.querySelector('[data-testid="readout-burn-rate"]')?.textContent).toBe('NO SIGNAL');
    // The fixed gauge slots render silent dashes, not 0.0%.
    expect(host.querySelector('[data-testid="quota-MAX_A-5h"]')?.textContent).toContain('—');
    expect(host.textContent).not.toContain('0.0%');
  });

  it('quota at 100% with resets_at in the past reads FAULT + R DUE (edge)', () => {
    act(() =>
      observabilityStore.getState().applyBatch([
        quotaGaugesSnap(
          [src('fresh', 'claude-quota', T0 - 1000)],
          [{ account: 'ENT', window: '5h', usedPct: 100, resetsAt: T0 - 60_000 }],
        ),
      ]),
    );
    renderDeck();
    expect(host.querySelector('[data-testid="readout-quota-gauges"]')?.textContent).toBe('FAULT');
    expect(host.querySelector('[data-testid="quota-ENT-5h"]')?.textContent).toContain('R DUE');
  });

  it('gateway down dims EVERY instrument to NO SIGNAL, slots retained (negative)', () => {
    act(() => observabilityStore.getState().applyBatch([quotaGaugesSnap([src('fresh')])]));
    act(() => connectionStore.getState().setPhase('no-broker'));
    renderDeck();
    const instruments = [...host.querySelectorAll('[data-instrument]')];
    expect(instruments).toHaveLength(10);
    for (const el of instruments) {
      expect(el.getAttribute('data-status')).toBe('nosignal');
      expect(el.textContent).toContain('NO GATEWAY');
    }
  });

  it('live quota-channel snapshots move a gauge between read-model recomputes', () => {
    act(() =>
      observabilityStore.getState().applyBatch([
        quotaGaugesSnap(
          [src('fresh', 'claude-quota', T0 - 1000)],
          [{ account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: T0 + 100_000 }],
          T0 - 5_000,
        ),
      ]),
    );
    renderDeck();
    expect(host.querySelector('[data-testid="quota-MAX_A-5h"]')?.textContent).toContain('41.5%');
    // A NEWER live snapshot wins the merge; an older one never regresses it.
    act(() =>
      quotaStore.getState().apply({
        kind: 'quota-snapshot',
        account: 'MAX_A',
        window: '5h',
        usedPct: 55.5,
        resetsAt: T0 + 90_000,
        capturedAt: T0,
        source: 'statusline',
      }),
    );
    expect(host.querySelector('[data-testid="quota-MAX_A-5h"]')?.textContent).toContain('55.5%');
  });
});
