// @vitest-environment jsdom
/**
 * FE-6 lineage render AUDIT (plan §9.2 FE-6 negative row; [X2] — the same
 * pattern as the launcher and dashboard audits).
 *
 * The claim under audit: across the rail, the lineage graph, the brief
 * viewer, the advisory strip and the merge preview — under ADVERSARIAL
 * open-vocabulary wire strings (titles, display names, git branches, brief
 * bodies) — the rendered markup never contains an identity-shaped string,
 * and account references render ONLY as the frozen placeholder labels.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ACCOUNT_LABELS } from '@aibender/protocol';
import { assertSynthesizedSafeText } from '@aibender/testkit';
import { connectionStore } from '../../lib/index.ts';
import { workstreamsStore } from './store.ts';
import { WorkstreamsDeck } from './WorkstreamsDeck.tsx';
import {
  adversarialStrings,
  advisory,
  brief,
  edgeEvent,
  listSnap,
  nodeEvent,
  summary,
  T0,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { emailish, awsIdish, tokenish } = adversarialStrings();

describe('render audit — no raw identifier can ever render [X2]', () => {
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

  function hydrateAdversarial(): void {
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap(
          [summary('ws_adv', { title: `ship it to ${emailish} soon` })],
          1,
        ),
        nodeEvent('ses_a', {
          workstreamId: 'ws_adv',
          displayName: `session for ${emailish}`,
          gitBranch: `feat/${tokenish}-wire`,
          cwd: '/synthetic/workspace',
          createdAt: T0,
        }),
        nodeEvent('ses_b', {
          workstreamId: 'ws_adv',
          displayName: `acct ${awsIdish} probe`,
          createdAt: T0 + 1,
        }),
        edgeEvent('edg_1', 'ses_a', 'ses_b'),
        brief('br_a', ['ses_a'], { body: `wrote to ${emailish}; key ${tokenish}; acct ${awsIdish}` }),
        advisory('ses_a', 74.2),
      ]),
    );
  }

  it('screens the full adversarial deck through the identity-shape guard', () => {
    hydrateAdversarial();
    renderDeck();
    click('ws-node-ses_a'); // focus → brief viewer renders the masked body
    const html = host.innerHTML;
    assertSynthesizedSafeText(html);
    expect(html).not.toContain(emailish);
    expect(html).not.toContain(awsIdish);
    expect(html).not.toContain(tokenish);
    expect(html).toContain('[MASKED]');
  });

  it('the merge preview seeds only masked text into the editor', () => {
    hydrateAdversarial();
    renderDeck();
    click('ws-node-ses_a');
    click('ws-node-ses_b');
    click('ws-merge-seed');
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="ws-merge-brief"]');
    expect(editor).not.toBeNull();
    assertSynthesizedSafeText(editor?.value ?? '');
    expect(editor?.value).not.toContain(emailish);
  });

  it('account references render only as the frozen placeholder labels', () => {
    hydrateAdversarial();
    renderDeck();
    const rows = [...host.querySelectorAll('[data-testid^="ws-node-"]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const account = row.querySelectorAll('span')[2]?.textContent ?? '';
      expect(ACCOUNT_LABELS as readonly string[]).toContain(account);
    }
  });

  it('never uses an off-token color in any rendered style attribute', () => {
    hydrateAdversarial();
    renderDeck();
    for (const el of host.querySelectorAll('[style]')) {
      const style = el.getAttribute('style') ?? '';
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style).not.toMatch(/(?<![a-zA-Z-])(?:rgba?|hsla?|oklch|oklab)\(/);
    }
  });
});
