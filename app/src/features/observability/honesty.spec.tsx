// @vitest-environment jsdom
/**
 * Honest-labeling AUDIT (blueprint §6.3; plan §9.2 FE-5 edge row:
 * "conflicting estimate-vs-actual rendered as overlay not sum").
 *
 * The claims under audit:
 *   1. the string "ACTUAL" can NEVER render while the cost feed is
 *      freshness=estimate-only — even against an adversarial snapshot that
 *      carries actual fields anyway;
 *   2. when actuals exist on an un-gated feed, estimate and actual render as
 *      SEPARATE engraved rows (an overlay) — never a summed figure;
 *   3. API-equivalent USD is always labeled an equivalence, never spend.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { connectionStore, quotaStore } from '../../lib/index.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { observabilityStore } from './store.ts';
import { bedrockSnap, fullDeckSnapshots, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('honest labeling audit', () => {
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

  it('"ACTUAL" never renders while freshness=estimate-only — full matrix', () => {
    // Adversarial matrix: estimate-only feeds carrying actual fields anyway,
    // in every source arrangement.
    const matrix = [
      bedrockSnap([src('estimate-only', 'bedrock-cost-explorer')], { estimateMtdUsd: 12.5 }),
      bedrockSnap([src('estimate-only', 'bedrock-cost-explorer')], {
        estimateMtdUsd: 12.5,
        actualMtdUsd: 11.8, // adversarial: actuals on a gated feed
        actualYesterdayUsd: 1.2,
        actualLagHours: 24,
      }),
      bedrockSnap(
        [
          src('estimate-only', 'bedrock-cost-explorer'),
          src('fresh', 'bedrock-cloudwatch', T0 - 1000),
        ],
        { estimateMtdUsd: 12.5, actualMtdUsd: 11.8 },
      ),
      bedrockSnap(
        [src('estimate-only', 'bedrock-cost-explorer'), src('sso-expired', 'bedrock-cloudwatch')],
        { estimateMtdUsd: 12.5, actualMtdUsd: 11.8 },
      ),
    ];
    for (const snapshot of matrix) {
      act(() => {
        observabilityStore.getState().reset();
        observabilityStore.getState().applyBatch([snapshot]);
      });
      renderDeck();
      expect(host.textContent).not.toMatch(/ACTUAL/);
      // The estimate still renders, labeled honestly — never a blank panel.
      expect(host.querySelector('[data-testid="bedrock-estimate"]')?.textContent).toContain(
        'ESTIMATE',
      );
    }
  });

  it('un-gated actuals render as an OVERLAY next to the estimate — never a sum', () => {
    act(() =>
      observabilityStore.getState().applyBatch([
        bedrockSnap([src('fresh', 'bedrock-cost-explorer', T0 - 1000)], {
          estimateMtdUsd: 12.5,
          actualMtdUsd: 11.8,
          actualYesterdayUsd: 1.2,
          actualLagHours: 24,
        }),
      ]),
    );
    renderDeck();
    const estimate = host.querySelector('[data-testid="bedrock-estimate"]')?.textContent ?? '';
    const actual = host.querySelector('[data-testid="bedrock-actual"]')?.textContent ?? '';
    expect(estimate).toContain('$12.50');
    expect(estimate).toContain('ESTIMATE');
    expect(actual).toContain('$11.80');
    expect(actual).toContain('ACTUAL');
    expect(actual).toContain('LAG 24H');
    expect(host.querySelector('[data-testid="bedrock-actual-yday"]')?.textContent).toContain(
      '$1.20',
    );
    // Overlay, not sum: the summed figure must not exist anywhere.
    expect(host.textContent).not.toContain('$24.30');
  });

  it('API-equivalent USD is engraved as equivalence, never spend', () => {
    act(() => observabilityStore.getState().applyBatch(fullDeckSnapshots()));
    renderDeck();
    const panel = host.querySelector('[data-testid="instrument-api-equivalent-usd"]');
    expect(panel?.textContent).toContain('EQUIVALENCE · NOT SPEND');
    expect(panel?.textContent).toContain('EQUIV');
    // The only "ACTUAL" in the entire deck belongs to un-gated Bedrock
    // actuals; the full synthetic deck (estimate-only) renders none.
    expect(host.textContent).not.toMatch(/ACTUAL/);
  });
});
