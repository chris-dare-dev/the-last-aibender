/**
 * FE-5 view tests (plan §9.2 FE-5 rows, M2 slice).
 *
 *  positive — the picker renders EXACTLY the five labels in slot order;
 *             composer/readout/history render their states;
 *  negative — ENT-degraded rendering: restricted slot retained but dimmed +
 *             engraved RESTRICTED; the skill composer HIDES its input for a
 *             restricted account (feature hidden, not error-toasted);
 *  edge     — free text is escaped (markup can never be smuggled); the
 *             catalog slot renders NO SIGNAL without a catalog and a picker
 *             with one.
 */

import { describe, expect, it } from 'vitest';

import { ACCOUNT_LABELS } from '@aibender/protocol';

import { buildAccountRegistry } from '../../lib/accountRegistry.ts';
import { accountPickerOptions } from './accounts.ts';
import { stubFeatureDetect, withAccountCapabilities } from './featureDetect.ts';
import { emptyLaunchDraft } from './launchDraft.ts';
import type { LauncherState } from './controller.ts';
import type { LaunchHistoryEntry } from './history.ts';
import { collectNodes, renderToHtml, textContent } from './view/html.ts';
import {
  accountPickerView,
  dispatchReadoutView,
  launchHistoryView,
  launchPanelView,
  skillComposerView,
} from './view/views.ts';

const detect = stubFeatureDetect();

const idleState = (draft = emptyLaunchDraft()): LauncherState => ({
  draft,
  dispatch: { phase: 'idle' },
});

const ENT_DEGRADED = withAccountCapabilities(detect, 'ENT', {
  oneOffPrompts: false,
  skills: false,
  restrictedReason: 'managed-policy',
});

describe('accountPickerView (positive)', () => {
  it('renders the configured registry + the two backend labels in slot order (seed = 5)', () => {
    const tree = accountPickerView('MAX_A', detect, 'prompt');
    const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.attrs['data-label'])).toEqual([...ACCOUNT_LABELS]);
    expect(options.map((o) => o.attrs['data-slot'])).toEqual(['1', '2', '3', '4', '5']);
  });

  it.each([
    ['3-Claude', ['MAX_A', 'MAX_B', 'ENT'], 5],
    ['4-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C'], 6],
    ['5-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D'], 7],
  ])(
    'renders N Claude accounts + the two backends for a %s registry, all placeholder-form',
    (_n, claude, total) => {
      const options = accountPickerOptions(buildAccountRegistry(claude));
      const detectN = stubFeatureDetect(buildAccountRegistry(claude));
      const tree = accountPickerView('MAX_A', detectN, 'prompt', options);
      const rendered = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
      expect(rendered).toHaveLength(total);
      expect(rendered.map((o) => o.attrs['data-label'])).toEqual([...claude, 'AWS_DEV', 'LOCAL']);
      // Every option label is a sanctioned placeholder — never a raw identifier.
      for (const o of rendered) {
        const label = o.attrs['data-label'] ?? '';
        expect(label).toMatch(/^(MAX_[A-Z]|ENT|AWS_DEV|LOCAL)$/);
      }
    },
  );

  it('marks the selected option and only it', () => {
    const tree = accountPickerView('AWS_DEV', detect, 'prompt');
    const checked = collectNodes(tree, (n) => n.attrs['aria-checked'] === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.attrs['data-label']).toBe('AWS_DEV');
  });

  it('renders one channel index tick per option (identity hue as token only), any N', () => {
    const options = accountPickerOptions(
      buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']),
    );
    const detectN = stubFeatureDetect(
      buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']),
    );
    const tree = accountPickerView('MAX_A', detectN, 'prompt', options);
    const ticks = collectNodes(tree, (n) => n.attrs['data-channel-tick'] !== undefined);
    expect(ticks).toHaveLength(7);
    for (const tick of ticks) {
      expect(tick.attrs['style']).toMatch(/background: var\(--ig-channel-[a-z-]+\);/);
    }
  });
});

describe('ENT-degraded rendering (negative)', () => {
  it('retains the ENT slot but renders it dimmed, disabled and RESTRICTED', () => {
    const tree = accountPickerView('MAX_A', ENT_DEGRADED, 'prompt');
    const options = collectNodes(tree, (n) => n.attrs['data-action'] === 'select-account');
    expect(options).toHaveLength(5); // the slot is retained — instruments never disappear
    const ent = options.find((o) => o.attrs['data-label'] === 'ENT');
    expect(ent?.attrs['aria-disabled']).toBe('true');
    expect(ent?.attrs['data-restricted']).toBe('true');
    expect(textContent(ent ?? '')).toContain('RESTRICTED');
    // Dimmed-instrument ink, not a status hue, not removal.
    expect(renderToHtml(ent ?? '')).toContain('var(--ig-ink-faint)');
  });

  it('hides the skill composer input for a restricted account (feature hidden)', () => {
    const state = idleState({ ...emptyLaunchDraft(), mode: 'skill', account: 'ENT' });
    const tree = skillComposerView(state, [], ENT_DEGRADED);
    const inputs = collectNodes(tree, (n) => n.attrs['data-field'] === 'skillText');
    expect(inputs).toHaveLength(0);
    const readouts = collectNodes(
      tree,
      (n) => n.attrs['data-part'] === 'skill-restricted-readout',
    );
    expect(readouts).toHaveLength(1);
    expect(textContent(tree)).toContain('RESTRICTED');
  });

  it('leaves capable accounts untouched by another account’s degradation', () => {
    const state = idleState({ ...emptyLaunchDraft(), mode: 'skill', account: 'MAX_B' });
    const tree = skillComposerView(state, [], ENT_DEGRADED);
    expect(collectNodes(tree, (n) => n.attrs['data-field'] === 'skillText')).toHaveLength(1);
  });
});

describe('skill catalog slot (edge)', () => {
  it('renders the NO SIGNAL dimmed instrument when no catalog exists (M2)', () => {
    const state = idleState({ ...emptyLaunchDraft(), mode: 'skill' });
    const tree = skillComposerView(state, [], detect);
    const slot = collectNodes(tree, (n) => n.attrs['data-part'] === 'skill-catalog-slot');
    expect(slot[0]?.attrs['data-state']).toBe('nosignal');
    expect(textContent(slot[0] ?? '')).toContain('NO SIGNAL');
  });

  it('renders catalog entries as picker options when a catalog is plugged in (M5 slot)', () => {
    const state = idleState({ ...emptyLaunchDraft(), mode: 'skill' });
    const tree = skillComposerView(state, [], detect, {
      list: () => [{ name: 'deep-research' }, { name: 'code-review' }],
    });
    const slot = collectNodes(tree, (n) => n.attrs['data-part'] === 'skill-catalog-slot');
    expect(slot[0]?.attrs['data-state']).toBe('ready');
    const options = collectNodes(slot[0] ?? '', (n) => n.attrs['role'] === 'option');
    expect(options.map((o) => textContent(o))).toEqual(['/deep-research', '/code-review']);
  });

  it('renders a parse readout for malformed non-empty skill text', () => {
    const state = idleState({ ...emptyLaunchDraft(), mode: 'skill', skillText: 'no-slash' });
    const tree = skillComposerView(state, [], detect);
    const readout = collectNodes(tree, (n) => n.attrs['data-part'] === 'skill-parse-readout');
    expect(textContent(readout[0] ?? '')).toBe('MUST START WITH /');
  });
});

describe('dispatch readout + history + escaping (edge)', () => {
  it('renders each dispatch phase as an engraved readout, never a spinner', () => {
    const draft = emptyLaunchDraft();
    const cases: readonly [LauncherState['dispatch'], string][] = [
      [{ phase: 'idle' }, 'READY'],
      [{ phase: 'dispatching', requestId: 'req_1' }, 'DISPATCHING …'],
      [{ phase: 'accepted', sessionId: 'ses_fake_1' }, 'SESSION ses_fake_1'],
      [{ phase: 'refused', issues: [] }, 'REFUSED'],
      [
        { phase: 'wire-error', error: { code: 'internal', message: 'x', retryable: false } },
        'FAULT internal',
      ],
      [{ phase: 'failed', note: 'TRANSPORT FAULT' }, 'FAULT TRANSPORT FAULT'],
    ];
    for (const [dispatch, expected] of cases) {
      const html = renderToHtml(dispatchReadoutView({ draft, dispatch }));
      expect(html).toContain(expected);
    }
  });

  it('renders history rows with outcome tints and the empty readout', () => {
    const entry: LaunchHistoryEntry = {
      at: Date.UTC(2026, 0, 1),
      kind: 'prompt',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'render test',
      promptPreview: 'synthesized preview',
      outcome: 'accepted',
      sessionId: 'ses_fake_1',
    };
    const tree = launchHistoryView([entry]);
    const rows = collectNodes(tree, (n) => n.attrs['data-part'] === 'history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attrs['style']).toContain('var(--ig-status-ok-tint)');
    expect(textContent(launchHistoryView([]))).toContain('EMPTY');
  });

  it('escapes free text everywhere — markup cannot be smuggled through a prompt', () => {
    const hostile = '<script>window.alert("x")</script> &" \' <img>';
    const state = idleState({
      ...emptyLaunchDraft(),
      prompt: hostile,
      purpose: hostile,
      cwd: hostile,
    });
    const html = renderToHtml(launchPanelView(state, detect, []));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the full panel with the mode toggle and submit affordance', () => {
    const html = renderToHtml(launchPanelView(idleState(), detect, []));
    expect(html).toContain('data-part="launch-panel"');
    expect(html).toContain('data-action="set-mode"');
    expect(html).toContain('data-action="submit"');
    expect(html).toContain('LAUNCH');
  });
});
