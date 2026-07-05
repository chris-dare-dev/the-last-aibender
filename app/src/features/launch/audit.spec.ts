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

import { isAccountLabel } from '@aibender/protocol';
import { assertSynthesizedSafeText } from '@aibender/testkit';

import { accountRegistry, buildAccountRegistry } from '../../lib/accountRegistry.ts';
import { accountPickerOptions } from './accounts.ts';
import { stubFeatureDetect, withAccountCapabilities } from './featureDetect.ts';
import type { FeatureDetectSnapshot } from './featureDetect.ts';
import { emptyLaunchDraft } from './launchDraft.ts';
import type { LauncherState } from './controller.ts';
import { LaunchHistoryStore, LAUNCH_HISTORY_STORAGE_KEY, type StorageLike } from './history.ts';
import { collectNodes, renderToHtml, textContent } from './view/html.ts';
import { accountPickerView, launchPanelView } from './view/views.ts';

const detect = stubFeatureDetect();

/**
 * [X1] audit registries: the seed three plus a 5-Claude registry that adds the
 * newly provisioned MAX_C / MAX_D. The audit must hold for EVERY N — no raw
 * identity can render regardless of how many accounts are configured.
 */
const REGISTRIES = {
  seed: accountRegistry(),
  fourClaude: buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']),
  fiveClaude: buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']),
} as const;

/** Every account label the audit renders across all registries (seed + MAX_C/D). */
const AUDITED_LABELS: readonly string[] = [
  ...new Set(
    Object.values(REGISTRIES).flatMap((r) => r.entries.map((e) => e.label)),
  ),
];

// Identity-shaped strings are runtime-built (testkit convention) so no
// scanner-shaped literal is committed to this public repo.
const emailish = ['owner.real', 'example.com'].join('@');
const awsIdish = '987654'.repeat(2);
const tokenish = ['sk', 'live0token0live0'].join('-');

/**
 * Every launcher state the audit renders — across a 5-Claude registry, so
 * MAX_C / MAX_D render alongside the seed labels ([X1]). Uses the 5-Claude
 * feature-detect stub so every configured account is a real, selectable slot.
 */
const fiveClaudeDetect = stubFeatureDetect(REGISTRIES.fiveClaude);

function stateMatrix(): { state: LauncherState; detect: FeatureDetectSnapshot }[] {
  const states: { state: LauncherState; detect: FeatureDetectSnapshot }[] = [];
  const degraded = withAccountCapabilities(fiveClaudeDetect, 'ENT', {
    oneOffPrompts: false,
    skills: false,
    restrictedReason: 'managed-policy',
  });
  for (const account of AUDITED_LABELS) {
    if (!isAccountLabel(account)) continue; // AUDITED_LABELS is placeholder-only
    for (const mode of ['prompt', 'skill'] as const) {
      for (const snapshot of [fiveClaudeDetect, degraded]) {
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

/** The 5-Claude picker options — the audit renders the panel against these. */
const fiveClaudeOptions = accountPickerOptions(REGISTRIES.fiveClaude);
const fiveClaudeLabels = fiveClaudeOptions.map((o) => o.label as string);

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
  it('screens the full state matrix (incl. MAX_C/MAX_D) through the identity-shape guard', () => {
    const history = adversarialHistory().list();
    for (const { state, detect: snapshot } of stateMatrix()) {
      const html = renderToHtml(launchPanelView(state, snapshot, history, undefined, fiveClaudeOptions));
      // The testkit guard: emails, 12-digit runs, token-shaped strings.
      assertSynthesizedSafeText(html);
    }
  });

  it('renders account references ONLY as sanctioned placeholder labels, for any N', () => {
    const history = adversarialHistory().list();
    for (const { state, detect: snapshot } of stateMatrix()) {
      const tree = launchPanelView(state, snapshot, history, undefined, fiveClaudeOptions);
      const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
      // The picker renders exactly the configured registry + the two backends
      // (5-Claude here) — no more, no fewer, and every label is the placeholder.
      expect(options.map((o) => o.attrs['data-label'])).toEqual(fiveClaudeLabels);
      for (const option of options) {
        const text = textContent(option);
        const label = option.attrs['data-label'] ?? '';
        expect(text).toContain(label);
        // Placeholder FORM only — never a raw identifier.
        expect(label).toMatch(/^(MAX_[A-Z]|ENT|AWS_DEV|LOCAL)$/);
      }
      // History rows can only carry re-validated placeholder labels.
      const rows = collectNodes(tree, (n) => n.attrs['data-history-label'] !== undefined);
      for (const row of rows) {
        const hl = row.attrs['data-history-label'] ?? '';
        expect(isAccountLabel(hl)).toBe(true);
      }
    }
  });

  it('a tampered detect snapshot cannot add an extra option or rename a label (any N)', () => {
    // Tamper BOTH: an identity-shaped detect key AND an identity-shaped label
    // smuggled into the registry input — the registry drops it fail-closed, so
    // the option set is exactly the sanctioned five (seed).
    const tampered = {
      ...detect,
      [emailish]: { oneOffPrompts: true, skills: true },
    } as unknown as FeatureDetectSnapshot;
    const tamperedOptions = accountPickerOptions(
      buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', emailish, awsIdish, 'HACKER']),
    );
    const tree = accountPickerView('MAX_A', tampered, 'prompt', tamperedOptions);
    const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
    expect(options).toHaveLength(5); // seed 3 Claude + 2 backends — garbage dropped
    expect(options.map((o) => o.attrs['data-label'])).toEqual([
      'MAX_A',
      'MAX_B',
      'ENT',
      'AWS_DEV',
      'LOCAL',
    ]);
    const html = renderToHtml(tree);
    expect(html).not.toContain(emailish);
    expect(html).not.toContain(awsIdish);
    expect(html).not.toContain('HACKER');
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
