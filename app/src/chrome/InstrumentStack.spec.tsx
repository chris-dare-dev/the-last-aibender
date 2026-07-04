// @vitest-environment jsdom
/**
 * Channel instruments (DESIGN.md §2.5/§2.4):
 * Positive: five panels render in FIXED slot order with engraved labels;
 *           quota drives OK/DEGRADED/FAULT readouts.
 * Negative: absent sources render the NO SIGNAL treatment (dimmed
 *           instrument, slot retained) — never an error; gateway down dims
 *           ALL instruments; auth failure is a visible FAULT readout.
 * Edge:     ENT surfaces the feature-detect degrade note (stub detector);
 *           data arrival never reorders panels.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deriveChannelReadings } from '../lib/stores/channelHealth.ts';
import { connectionStore } from '../lib/stores/connectionStore.ts';
import { quotaStore } from '../lib/stores/quotaStore.ts';
import { sessionsStore } from '../lib/stores/sessionsStore.ts';
import { gatewayReadout, StatusBar } from './StatusBar.tsx';
import { InstrumentStack } from './InstrumentStack.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(account: 'MAX_A' | 'MAX_B' | 'ENT', usedPct: number, capturedAt = 90100000) {
  return {
    kind: 'quota-snapshot' as const,
    account,
    window: '5h' as const,
    usedPct,
    resetsAt: 90200000,
    capturedAt,
    source: 'statusline' as const,
  };
}

describe('deriveChannelReadings (selectors)', () => {
  beforeEach(() => {
    quotaStore.getState().reset();
    sessionsStore.getState().reset();
  });

  it('maps quota thresholds to the normative statuses', () => {
    quotaStore.getState().apply(snapshot('MAX_A', 41.5));
    quotaStore.getState().apply(snapshot('MAX_B', 82.3));
    quotaStore.getState().apply(snapshot('ENT', 100));
    const readings = deriveChannelReadings({
      phase: 'connected',
      quota: quotaStore.getState().snapshots,
      sessions: {},
    });
    expect(readings.map((r) => `${r.channel}:${r.status}`)).toEqual([
      'MAX_A:ok',
      'MAX_B:degraded',
      'ENT:fault',
      'BEDROCK:nosignal',
      'LMSTUDIO:nosignal',
    ]);
    // ENT carries the stub feature-detect degrade note (edge).
    expect(readings[2]?.detail).toContain('FEATURE-DETECT PENDING');
    // LM Studio down offers the one-click remediation (NO SIGNAL doctrine).
    expect(readings[4]?.remediation).toBe('LMS SERVER START');
  });

  it('gateway down ⇒ every instrument reads NO SIGNAL (negative)', () => {
    const readings = deriveChannelReadings({ phase: 'no-broker', quota: {}, sessions: {} });
    expect(readings.every((r) => r.status === 'nosignal')).toBe(true);
    expect(readings[0]?.detail).toBe('NO GATEWAY');
  });
});

describe('InstrumentStack component', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    quotaStore.getState().reset();
    sessionsStore.getState().reset();
    connectionStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<InstrumentStack />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function panelOrder(): (string | null)[] {
    return [...host.querySelectorAll('[data-channel]')].map((el) => el.getAttribute('data-channel'));
  }

  it('renders the five fixed slots in order even with zero data', () => {
    expect(panelOrder()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'BEDROCK', 'LMSTUDIO']);
    expect(host.querySelector('[data-testid="readout-MAX_A"]')?.textContent).toBe('NO SIGNAL');
  });

  it('data arrival changes readouts but NEVER the slot order (edge)', () => {
    act(() => {
      connectionStore.getState().setPhase('connected');
      // Deliberately out of slot order:
      quotaStore.getState().apply(snapshot('ENT', 10));
      quotaStore.getState().apply(snapshot('MAX_A', 99));
    });
    expect(panelOrder()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'BEDROCK', 'LMSTUDIO']);
    expect(host.querySelector('[data-testid="readout-MAX_A"]')?.textContent).toBe('DEGRADED');
    expect(host.querySelector('[data-testid="readout-ENT"]')?.textContent).toBe('OK');
    expect(host.querySelector('[data-testid="readout-MAX_B"]')?.textContent).toBe('NO SIGNAL');
    // NO SIGNAL panel is dimmed via data-status, slot retained.
    expect(host.querySelector('[data-testid="channel-MAX_B"]')?.getAttribute('data-status')).toBe(
      'nosignal',
    );
  });
});

describe('gateway readout (auth visibility)', () => {
  it('maps auth-rejected to a FAULT readout', () => {
    expect(gatewayReadout('auth-rejected')).toEqual({ text: 'AUTH FAULT', status: 'fault' });
  });

  it('renders AUTH FAULT in the status bar when the token is rejected', () => {
    connectionStore.getState().reset();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<StatusBar />);
    });
    act(() => {
      connectionStore.getState().setPhase('auth-rejected');
    });
    const readout = host.querySelector('[data-testid="gateway-readout"]');
    expect(readout?.textContent).toBe('AUTH FAULT');
    expect(readout?.className).toContain('ig-status-fault');
    act(() => root.unmount());
    host.remove();
  });
});
