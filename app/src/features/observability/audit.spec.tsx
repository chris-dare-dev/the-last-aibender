// @vitest-environment jsdom
/**
 * FE-5 dashboard render AUDIT (plan §9.2 FE-5 negative row: "no dashboard
 * ever shows a raw identifier (audit render test)"; [X2] — same pattern as
 * the M2 launcher/picker audit).
 *
 * The claim under audit: across every dashboard, every freshness state and
 * ADVERSARIAL open-vocabulary wire strings (skill names, outcome facets),
 * the rendered markup never contains an identity-shaped string, and account
 * references render ONLY as the frozen placeholder labels.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ACCOUNT_LABELS } from '@aibender/protocol';
import { assertSynthesizedSafeText } from '@aibender/testkit';
import { connectionStore, quotaStore } from '../../lib/index.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { observabilityStore } from './store.ts';
import {
  adversarialStrings,
  fullDeckSnapshots,
  outcomesSnap,
  skillsSnap,
  T0,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { emailish, awsIdish, tokenish } = adversarialStrings();

describe('render audit — no raw identifier can ever render [X2]', () => {
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

  it('screens the full synthetic deck through the identity-shape guard', () => {
    act(() => observabilityStore.getState().applyBatch(fullDeckSnapshots()));
    renderDeck();
    assertSynthesizedSafeText(host.innerHTML);
  });

  it('adversarial open-vocabulary wire strings are shape-masked before render', () => {
    act(() =>
      observabilityStore.getState().applyBatch([
        skillsSnap([
          {
            skillName: `${emailish}-skill`,
            invocations: 3,
            worstQuartile: true,
          },
          {
            skillName: `uses ${tokenish} inline`,
            invocations: 2,
            worstQuartile: false,
          },
        ]),
        outcomesSnap([
          { outcome: `mailed ${emailish}`, count: 1 },
          { outcome: `acct ${awsIdish}`, count: 2 },
        ]),
      ]),
    );
    renderDeck();
    const html = host.innerHTML;
    assertSynthesizedSafeText(html);
    expect(html).not.toContain(emailish);
    expect(html).not.toContain(awsIdish);
    expect(html).not.toContain(tokenish);
    expect(html).toContain('[MASKED]');
  });

  it('worst-quartile flags render on flagged rows only — never on sparse data', () => {
    act(() =>
      observabilityStore.getState().applyBatch([
        skillsSnap([
          { skillName: 'flagged-skill', invocations: 40, successRatePct: 20, worstQuartile: true },
          { skillName: 'sparse-skill', invocations: 1, worstQuartile: false },
        ]),
      ]),
    );
    renderDeck();
    const rows = [...host.querySelectorAll('[data-worst-quartile]')];
    expect(rows.map((r) => r.getAttribute('data-worst-quartile'))).toEqual(['true', 'false']);
    expect(host.querySelectorAll('[data-testid="worst-quartile-flag"]')).toHaveLength(1);
    // Sparse rows read an engraved dash, never a fabricated rate.
    expect(host.querySelector('[data-testid="skill-sparse-skill"]')?.textContent).toContain('—');
  });

  it('account references render only as the frozen placeholder labels', () => {
    act(() => observabilityStore.getState().applyBatch(fullDeckSnapshots()));
    renderDeck();
    const keys = [...host.querySelectorAll('[data-testid^="quota-"], [data-testid^="burn-"], [data-testid^="equiv-"], [data-testid^="cache-"]')];
    expect(keys.length).toBeGreaterThan(0);
    for (const el of keys) {
      const label = (el.getAttribute('data-testid') ?? '').split('-')[1];
      expect(ACCOUNT_LABELS as readonly string[]).toContain(label ?? '');
    }
  });

  it('never uses an off-token color in any rendered style attribute', () => {
    act(() => observabilityStore.getState().applyBatch(fullDeckSnapshots()));
    renderDeck();
    for (const el of host.querySelectorAll('[style]')) {
      const style = el.getAttribute('style') ?? '';
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style).not.toMatch(/(?<![a-zA-Z-])(?:rgba?|hsla?|oklch|oklab)\(/);
    }
  });
});
