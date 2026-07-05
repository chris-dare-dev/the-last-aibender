// @vitest-environment jsdom
/**
 * [X2] account-routing render audit (plan §5/FE-6: "an [X2] audit test that no
 * raw identifier can render"). The deck renders account routing PROMINENTLY —
 * the [X1] differentiator — but ONLY as the five frozen placeholder labels. No
 * real email, no 12-digit AWS-account run, no token-shaped string may ever
 * reach the DOM, and no account chip may carry a label outside the frozen set.
 * Adversarial identity-shaped strings (runtime-built) planted in every
 * open-vocabulary wire field are masked before render.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ACCOUNT_LABELS } from '@aibender/protocol';
import { connectionStore } from '../../lib/index.ts';
import { pipelinesStore } from './store.ts';
import { PipelinesDeck } from './PipelinesDeck.tsx';
import {
  adversarialStrings,
  catalogEntry,
  catalogSnapshot,
  runSnapshot,
  runStatus,
  stepStatus,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FROZEN_LABELS = new Set<string>([...ACCOUNT_LABELS, 'DEFAULT']);

describe('[X2] account-routing render audit', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    pipelinesStore.getState().reset();
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
    act(() => root.render(<PipelinesDeck />));
  }

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing ${testId}`);
    act(() => el.click());
  }

  it('every account chip carries ONLY a frozen placeholder label', () => {
    // A run whose steps route across all five accounts.
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'running'), [
        stepStatus('run_1', 'a', 'running', { account: 'MAX_A' }),
        stepStatus('run_1', 'b', 'running', { account: 'MAX_B' }),
        stepStatus('run_1', 'c', 'running', { account: 'ENT' }),
        stepStatus('run_1', 'd', 'running', { account: 'AWS_DEV' }),
        stepStatus('run_1', 'e', 'running', { account: 'LOCAL' }),
      ]),
    ]);
    render();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    const chips = [...host.querySelectorAll('[data-testid^="pl-run-step-account-"]')];
    expect(chips.length).toBe(5);
    for (const chip of chips) {
      const account = chip.getAttribute('data-account') ?? '';
      expect(FROZEN_LABELS.has(account)).toBe(true);
      // The visible text is exactly the frozen label — nothing else.
      expect(FROZEN_LABELS.has((chip.textContent ?? '').trim())).toBe(true);
    }
  });

  it('adversarial identity-shaped wire strings never reach the DOM', () => {
    const { emailish, awsIdish, tokenish } = adversarialStrings();
    // Plant the adversarial strings in every open-vocabulary wire field the
    // deck renders: catalog capability name, workspace path, step errorKind.
    pipelinesStore.getState().applyBatch([
      catalogSnapshot(
        [catalogEntry('cap_evil', { name: emailish })],
        { workspace: awsIdish },
      ),
    ]);
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'failed'), [
        stepStatus('run_1', 'a', 'failed', { account: 'MAX_A', errorKind: tokenish }),
      ]),
    ]);
    render();
    // Builder mode: the palette masks the capability name.
    const html1 = host.innerHTML;
    // Monitor mode: the error kind is masked.
    click('pl-mode-monitor');
    click('pl-run-run_1');
    const html2 = host.innerHTML;
    const all = html1 + html2;

    expect(all).not.toContain(emailish);
    expect(all).not.toContain(awsIdish);
    expect(all).not.toContain(tokenish);
    // The mask marker IS present where an adversarial string was planted.
    expect(all).toContain('[MASKED]');
  });

  it('no 12-digit run appears anywhere in the deck DOM (broad sweep)', () => {
    const { awsIdish } = adversarialStrings();
    pipelinesStore.getState().applyBatch([
      catalogSnapshot([catalogEntry('cap_1', { name: `report ${awsIdish}` })]),
    ]);
    render();
    // A raw 12-digit run must never survive to the rendered text.
    expect(/\d{12}/.test(host.textContent ?? '')).toBe(false);
  });
});
