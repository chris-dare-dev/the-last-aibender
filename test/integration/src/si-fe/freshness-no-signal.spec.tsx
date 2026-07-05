// @vitest-environment jsdom
/**
 * §9.3 SI↔FE #4 — freshness surfaces: LM-Studio-down / cluster-absent /
 * SSO-expired each render the NO SIGNAL instrument (dimmed, slot retained,
 * remediation offered) — NEVER an error toast, NEVER a fabricated zero.
 *
 * These three are the SI-owned degradations (LM Studio is SI-5's `lms`
 * server; cluster-absent is the [X3] Colima adjunct being down; SSO-expired
 * is SI-4's AWS auth). The per-department FE suite
 * (app/src/features/observability/freshness.spec.tsx) proves ALL frozen
 * states; THIS suite asserts the CROSS-DEPARTMENT clause for exactly the SI
 * degradations, driving the REAL FE deck + REAL selectors and asserting the
 * anti-toast doctrine (DESIGN.md §2.4): no `role="alert"`, no toast element,
 * no error banner — only the engraved NO SIGNAL instrument with a copyable
 * one-click remediation.
 *
 * We ASSEMBLE the FE deck, selectors, and stores; the freshness STATES come
 * from the frozen protocol vocabulary (the wire the BE publisher emits).
 *
 * [X2]: synthesized snapshots; no identity in the DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SourceFreshnessState } from '@aibender/protocol';

import { deriveInstrumentHealth, remediationFor } from '../../../../app/src/features/observability/freshness.ts';
import { ObservabilityDeck } from '../../../../app/src/features/observability/ObservabilityDeck.tsx';
import { observabilityStore } from '../../../../app/src/features/observability/store.ts';
import { quotaGaugesSnap, src, T0 } from '../../../../app/src/features/observability/specHelpers.ts';
import { connectionStore, quotaStore } from '../../../../app/src/lib/index.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The three SI-owned degradations named in §9.3 SI↔FE #4, with the remediation
// each surfaces (or none, when the fix is not a single owner command).
const SI_DEGRADATIONS: ReadonlyArray<{
  state: SourceFreshnessState;
  remediation?: string;
}> = [
  { state: 'lmstudio-down', remediation: 'lms server start' },
  { state: 'cluster-absent' }, // Colima adjunct down — no single owner command
  { state: 'sso-expired', remediation: 'aws sso login' },
];

describe('SI↔FE #4 — SI degradations render NO SIGNAL, never a toast (selectors)', () => {
  it('every SI degradation folds to the NO SIGNAL readout', () => {
    for (const { state } of SI_DEGRADATIONS) {
      const health = deriveInstrumentHealth([src(state)]);
      expect(`${state}:${health.readout}`).toBe(`${state}:NO SIGNAL`);
      expect(health.status).toBe('nosignal');
    }
  });

  it('remediation is offered exactly where an owner command exists', () => {
    for (const { state, remediation } of SI_DEGRADATIONS) {
      expect(remediationFor(state)?.command).toBe(remediation);
    }
  });
});

describe('SI↔FE #4 — SI degradations render NO SIGNAL in the real deck, no toast', () => {
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

  it.each(SI_DEGRADATIONS.map((d) => [d.state, d] as const))(
    '%s: dimmed NO SIGNAL instrument, remediation where applicable, and NO toast/error',
    (state, degradation) => {
      act(() =>
        observabilityStore
          .getState()
          .applyBatch([quotaGaugesSnap([src(state, 'claude-quota', T0 - 1000)])]),
      );
      const copied: string[] = [];
      act(() => root.render(<ObservabilityDeck now={() => T0} copyText={(t) => copied.push(t)} />));

      // Readout is NO SIGNAL; the instrument slot is dimmed, not removed.
      const readout = host.querySelector('[data-testid="readout-quota-gauges"]');
      expect(readout?.textContent).toBe('NO SIGNAL');
      const instrument = host.querySelector('[data-instrument="quota-gauges"]');
      expect(instrument?.getAttribute('data-status')).toBe('nosignal');

      // The doctrine: NEVER an error toast / alert / banner (DESIGN.md §2.4).
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('.toast, [data-toast], [data-error-toast]')).toBeNull();
      // Never a fabricated zero in place of the missing signal.
      expect(host.textContent).not.toContain('0.0%');

      // Remediation is a copyable one-click affordance where an owner command
      // exists; clicking COPIES the command (owner runs it, harness never does).
      if (degradation.remediation !== undefined) {
        const button = host.querySelector<HTMLButtonElement>(
          `[data-remediation="${degradation.remediation}"]`,
        );
        expect(button).not.toBeNull();
        act(() => button?.click());
        expect(copied).toEqual([degradation.remediation]);
      }
    },
  );
});
