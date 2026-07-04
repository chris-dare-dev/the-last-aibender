/**
 * FE-5 render AUDIT (plan §9.2 FE-5 negative row: "no dashboard ever shows a
 * raw identifier (audit render test)"; [X2]).
 *
 * The claim under audit: across every launcher state — all selections, both
 * modes, degraded snapshots, adversarial free text, tampered persistence,
 * tampered detect snapshots — the rendered markup NEVER contains a raw
 * identifier. Account references render as the five placeholder labels and
 * NOTHING else; identity-shaped free text is masked before it can reach a
 * view.
 */

import { describe, expect, it } from 'vitest';

import { ACCOUNT_LABELS } from '@aibender/protocol';
import { assertSynthesizedSafeText } from '@aibender/testkit';

import { stubFeatureDetect, withAccountCapabilities } from './featureDetect.ts';
import type { FeatureDetectSnapshot } from './featureDetect.ts';
import { emptyLaunchDraft } from './launchDraft.ts';
import type { LauncherState } from './controller.ts';
import { LaunchHistoryStore, LAUNCH_HISTORY_STORAGE_KEY, type StorageLike } from './history.ts';
import { collectNodes, renderToHtml, textContent } from './view/html.ts';
import { accountPickerView, launchPanelView } from './view/views.ts';

const detect = stubFeatureDetect();

// Identity-shaped strings are runtime-built (testkit convention) so no
// scanner-shaped literal is committed to this public repo.
const emailish = ['owner.real', 'example.com'].join('@');
const awsIdish = '987654'.repeat(2);
const tokenish = ['sk', 'live0token0live0'].join('-');

/** Every launcher state the audit renders. */
function stateMatrix(): { state: LauncherState; detect: FeatureDetectSnapshot }[] {
  const states: { state: LauncherState; detect: FeatureDetectSnapshot }[] = [];
  const degraded = withAccountCapabilities(detect, 'ENT', {
    oneOffPrompts: false,
    skills: false,
    restrictedReason: 'managed-policy',
  });
  for (const account of ACCOUNT_LABELS) {
    for (const mode of ['prompt', 'skill'] as const) {
      for (const snapshot of [detect, degraded]) {
        states.push({
          detect: snapshot,
          state: {
            draft: {
              ...emptyLaunchDraft(),
              account,
              mode,
              cwd: '/synthetic/workspace',
              purpose: `audit render ${account}`,
              prompt: `synthesized ${mode} text`,
              skillText: '/deep-research audit',
              workstreamHint: 'ws_audit',
            },
            dispatch: { phase: 'idle' },
          },
        });
      }
    }
  }
  return states;
}

/** History fed ADVERSARIAL text through the real store (masked at record). */
function adversarialHistory(): LaunchHistoryStore {
  const store = new LaunchHistoryStore({ now: () => Date.UTC(2026, 0, 1) });
  store.record({
    kind: 'prompt',
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: `/home/${emailish}/work`,
    purpose: `mail ${emailish}`,
    promptText: `use ${tokenish} on account ${awsIdish}`,
    outcome: 'accepted',
    sessionId: 'ses_fake_1',
  });
  store.record({
    kind: 'skill',
    accountLabel: 'LOCAL',
    backend: 'lmstudio',
    substrate: 'sdk',
    cwd: '/synthetic/workspace',
    purpose: 'skill /audit-skill',
    promptText: '/audit-skill args',
    outcome: 'wire-error',
    errorCode: 'internal',
  });
  return store;
}

describe('render audit — no raw identifier can ever render [X2]', () => {
  it('screens the full state matrix through the identity-shape guard', () => {
    const history = adversarialHistory().list();
    for (const { state, detect: snapshot } of stateMatrix()) {
      const html = renderToHtml(launchPanelView(state, snapshot, history));
      // The testkit guard: emails, 12-digit runs, token-shaped strings.
      assertSynthesizedSafeText(html);
    }
  });

  it('renders account references ONLY as the five placeholder labels', () => {
    const history = adversarialHistory().list();
    for (const { state, detect: snapshot } of stateMatrix()) {
      const tree = launchPanelView(state, snapshot, history);
      const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
      expect(options.map((o) => o.attrs['data-label'])).toEqual([...ACCOUNT_LABELS]);
      // Every engraved account text node in the picker is a frozen label.
      for (const option of options) {
        const text = textContent(option);
        const label = option.attrs['data-label'] ?? '';
        expect(text).toContain(label);
      }
      // History rows can only carry re-validated placeholder labels.
      const rows = collectNodes(tree, (n) => n.attrs['data-history-label'] !== undefined);
      for (const row of rows) {
        expect(ACCOUNT_LABELS as readonly string[]).toContain(
          row.attrs['data-history-label'] ?? '',
        );
      }
    }
  });

  it('a tampered detect snapshot cannot add a sixth option or rename a label', () => {
    const tampered = {
      ...detect,
      [emailish]: { oneOffPrompts: true, skills: true },
    } as unknown as FeatureDetectSnapshot;
    const tree = accountPickerView('MAX_A', tampered, 'prompt');
    const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
    expect(options).toHaveLength(5);
    expect(renderToHtml(tree)).not.toContain(emailish);
  });

  it('a tampered persistence layer cannot inject an identifier into the render', () => {
    class TamperedStorage implements StorageLike {
      getItem(): string {
        return JSON.stringify([
          {
            at: 1,
            kind: 'prompt',
            accountLabel: emailish, // not a placeholder → row dropped
            backend: 'claude_code',
            substrate: 'sdk',
            cwd: '/synthetic/x',
            purpose: 'tampered row',
            promptPreview: 'tampered',
            outcome: 'accepted',
          },
          {
            at: 2,
            kind: 'prompt',
            accountLabel: 'MAX_B', // kept — but its free text is re-masked
            backend: 'claude_code',
            substrate: 'sdk',
            cwd: '/synthetic/x',
            purpose: `mail ${emailish}`,
            promptPreview: `account ${awsIdish} key ${tokenish}`,
            outcome: 'failed',
          },
        ]);
      }
      setItem(): void {
        /* discard */
      }
    }
    const store = new LaunchHistoryStore({ storage: new TamperedStorage() });
    expect(store.list()).toHaveLength(1);
    const html = renderToHtml(
      launchPanelView(
        { draft: emptyLaunchDraft(), dispatch: { phase: 'idle' } },
        detect,
        store.list(),
      ),
    );
    assertSynthesizedSafeText(html);
    expect(html).not.toContain(emailish);
    expect(html).not.toContain(awsIdish);
    expect(html).not.toContain(tokenish);
  });

  it('never uses an off-token color in any rendered style attribute', () => {
    const history = adversarialHistory().list();
    for (const { state, detect: snapshot } of stateMatrix()) {
      const html = renderToHtml(launchPanelView(state, snapshot, history));
      for (const match of html.matchAll(/style="([^"]*)"/g)) {
        const style = match[1] ?? '';
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(style).not.toMatch(/(?<![a-zA-Z-])(?:rgba?|hsla?|oklch|oklab)\(/);
      }
    }
  });

  it('storage key stays versioned and identity-free', () => {
    expect(LAUNCH_HISTORY_STORAGE_KEY).toBe('aibender.launch.history.v1');
  });
});
