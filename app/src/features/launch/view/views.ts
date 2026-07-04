/**
 * FE-5 launch views — pure `state → VNode` functions (M2 slice: features 2/3).
 *
 * DESIGN.md discipline (LOCKED):
 *   - every color/size/font reference is a `var(--ig-*)` token — the token
 *     lint scans this file (§8.3);
 *   - engraved mono-caps labels per §2.5 spec (the sanctioned exception);
 *   - channel index hues appear ONLY as the 2×16px identity tick;
 *   - restricted/absent sources use the dimmed-instrument treatment (§2.4),
 *     never an error toast, never removed slots;
 *   - status hues are semantic only (fault = refused/failed readouts);
 *   - no cards, no shadows, no radii beyond tokens, hairline rules only.
 *
 * Interactivity contract: actionable elements carry `data-action` (+ payload
 * `data-*`) attributes decoded by `parseLaunchAction` (controller.ts). Views
 * never receive callbacks — the FE-2 shell owns event delegation.
 */

import type { AccountLabel } from '@aibender/protocol';

import { accountPickerOptions } from '../accounts.ts';
import { capabilitiesFor, type FeatureDetectSnapshot } from '../featureDetect.ts';
import type { LauncherState } from '../controller.ts';
import type { DraftIssue, LaunchMode } from '../launchDraft.ts';
import type { LaunchHistoryEntry } from '../history.ts';
import { parseSkillCommand, skillIssueReadout, type SkillCatalogSlot } from '../skill.ts';
import { FREE_TEXT_CATALOG_SLOT } from '../skill.ts';
import { h, type VNode } from './html.ts';

// ---------------------------------------------------------------------------
// Shared style fragments (tokens only)
// ---------------------------------------------------------------------------

const ENGRAVED_LABEL_STYLE =
  'font-family: var(--ig-font-mono); font-size: var(--ig-type-label); ' +
  'line-height: var(--ig-type-label-lh); letter-spacing: var(--ig-tracking-engraved); ' +
  'text-transform: uppercase; color: var(--ig-ink-muted);';

const DATA_TEXT_STYLE =
  'font-family: var(--ig-font-mono); font-size: var(--ig-type-data); ' +
  'line-height: var(--ig-type-data-lh); color: var(--ig-ink-primary); ' +
  'font-variant-numeric: var(--ig-numeric);';

const HAIRLINE_TOP = 'border-top: var(--ig-line-width) solid var(--ig-line-hairline);';

const engraved = (text: string, extra = ''): VNode =>
  h('span', { style: `${ENGRAVED_LABEL_STYLE}${extra}` }, text);

// ---------------------------------------------------------------------------
// Account picker (feature 2/3 shared) — EXACTLY the five labels
// ---------------------------------------------------------------------------

/**
 * The account picker: five fixed slots in frozen order (§2.5 — instruments
 * never reorder or disappear). Option text comes ONLY from the frozen
 * ACCOUNT_LABELS vocabulary via accountPickerOptions(); a restricted account
 * (for the active mode) renders dimmed + engraved RESTRICTED, still in slot.
 */
export function accountPickerView(
  selected: AccountLabel,
  detect: FeatureDetectSnapshot,
  mode: LaunchMode,
): VNode {
  const feature = mode === 'prompt' ? 'oneOffPrompts' : 'skills';
  const options = accountPickerOptions().map((option) => {
    const capabilities = capabilitiesFor(detect, option.label);
    const restricted = !capabilities[feature];
    const isSelected = !restricted && option.label === selected;
    const ink = restricted
      ? 'var(--ig-ink-faint)'
      : isSelected
        ? 'var(--ig-accent)'
        : 'var(--ig-ink-secondary)';
    return h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': isSelected ? 'true' : 'false',
        'aria-disabled': restricted ? 'true' : 'false',
        'data-action': 'select-account',
        'data-label': option.label,
        'data-slot': String(option.slot),
        ...(restricted ? { 'data-restricted': 'true' } : {}),
        style:
          'display: block; width: 100%; text-align: left; background: var(--ig-surface-panel); ' +
          'border: none; padding: var(--ig-space-8) var(--ig-space-12); cursor: pointer; ' +
          `${HAIRLINE_TOP}`,
      },
      h(
        'span',
        {
          style: `${ENGRAVED_LABEL_STYLE} color: ${ink};`,
        },
        option.label,
      ),
      // §2.5: the 2×16px channel index tick — identity hue, hairline-scale.
      h('span', {
        'data-channel-tick': option.label,
        style:
          `display: block; width: 16px; height: 2px; background: ${option.channelTokenVar}; ` +
          'margin-top: var(--ig-space-2);',
      }),
      restricted
        ? engraved('RESTRICTED', ' color: var(--ig-ink-faint);')
        : engraved(option.backend, ' color: var(--ig-ink-muted);'),
    );
  });

  return h(
    'div',
    {
      role: 'radiogroup',
      'aria-label': 'ACCOUNT',
      'data-part': 'account-picker',
    },
    engraved('ACCOUNT'),
    ...options,
  );
}

// ---------------------------------------------------------------------------
// Composer fields
// ---------------------------------------------------------------------------

const fieldStyle =
  'display: block; width: 100%; background: var(--ig-surface-well); ' +
  'border: var(--ig-line-width) solid var(--ig-line-hairline); ' +
  'border-radius: var(--ig-radius-1); color: var(--ig-ink-primary); ' +
  'font-family: var(--ig-font-mono); font-size: var(--ig-type-data); ' +
  'line-height: var(--ig-type-data-lh); padding: var(--ig-space-4) var(--ig-space-8);';

function labeledField(
  label: string,
  field: 'cwd' | 'purpose' | 'prompt' | 'skillText' | 'workstreamHint',
  value: string,
  issues: readonly DraftIssue[],
  multiline = false,
): VNode {
  const issue = issues.find((i) => i.field === field);
  const control = multiline
    ? h(
        'textarea',
        { 'data-action': 'set-field', 'data-field': field, rows: '4', style: fieldStyle },
        value,
      )
    : h('input', {
        type: 'text',
        'data-action': 'set-field',
        'data-field': field,
        value,
        style: fieldStyle,
      });
  return h(
    'label',
    { style: 'display: block; margin-top: var(--ig-space-12);', 'data-field-row': field },
    engraved(label),
    control,
    issue !== undefined
      ? h(
          'span',
          {
            'data-issue': field,
            style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-status-fault);`,
          },
          issue.readout,
        )
      : undefined,
  );
}

/** One-off prompt composer (feature 2). */
export function promptComposerView(state: LauncherState, issues: readonly DraftIssue[]): VNode {
  const { draft } = state;
  return h(
    'div',
    { 'data-part': 'prompt-composer' },
    labeledField('PROMPT', 'prompt', draft.prompt, issues, true),
    labeledField('CWD', 'cwd', draft.cwd, issues),
    labeledField('PURPOSE', 'purpose', draft.purpose, issues),
    labeledField('WORKSTREAM HINT', 'workstreamHint', draft.workstreamHint, issues),
  );
}

/**
 * Skill composer (feature 3): `/skill-name args` free text + the catalog
 * picker SLOT. No catalog (M2) → the slot renders as a dimmed NO SIGNAL
 * instrument (§2.4) — the slot is designed now so the M5 catalog drops in
 * without a UI rewrite. If the active account's `skills` capability is off,
 * the composer input is HIDDEN (plan §9.2 FE-5 negative row) and only the
 * restricted readout renders.
 */
export function skillComposerView(
  state: LauncherState,
  issues: readonly DraftIssue[],
  detect: FeatureDetectSnapshot,
  catalog: SkillCatalogSlot = FREE_TEXT_CATALOG_SLOT,
): VNode {
  const { draft } = state;
  const capabilities = capabilitiesFor(detect, draft.account);

  if (!capabilities.skills) {
    return h(
      'div',
      { 'data-part': 'skill-composer', 'data-restricted': 'true' },
      engraved('SKILLS', ' color: var(--ig-ink-faint);'),
      h(
        'span',
        {
          'data-part': 'skill-restricted-readout',
          style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-ink-faint);`,
        },
        'RESTRICTED',
      ),
    );
  }

  const parsed = parseSkillCommand(draft.skillText, catalog);
  const entries = catalog.list();

  const catalogSlot =
    entries === undefined
      ? h(
          'div',
          { 'data-part': 'skill-catalog-slot', 'data-state': 'nosignal' },
          engraved('CATALOG', ' color: var(--ig-ink-faint);'),
          h(
            'span',
            { style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-ink-faint);` },
            'NO SIGNAL',
          ),
          h(
            'span',
            { style: `${ENGRAVED_LABEL_STYLE}` },
            'FREE TEXT UNTIL CATALOG LANDS',
          ),
        )
      : h(
          'div',
          { 'data-part': 'skill-catalog-slot', 'data-state': 'ready', role: 'listbox' },
          engraved('CATALOG'),
          ...entries.map((entry) =>
            h(
              'button',
              {
                type: 'button',
                role: 'option',
                'data-action': 'set-field',
                'data-field': 'skillText',
                'data-value': `/${entry.name} `,
                style: `${DATA_TEXT_STYLE} background: var(--ig-surface-panel); border: none; ` +
                  'display: block; width: 100%; text-align: left; cursor: pointer;',
              },
              `/${entry.name}`,
            ),
          ),
        );

  return h(
    'div',
    { 'data-part': 'skill-composer' },
    labeledField('SKILL COMMAND', 'skillText', draft.skillText, issues),
    draft.skillText.trim().length > 0 && !parsed.ok
      ? h(
          'span',
          {
            'data-part': 'skill-parse-readout',
            style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-status-fault);`,
          },
          skillIssueReadout(parsed.issue),
        )
      : undefined,
    catalogSlot,
    labeledField('CWD', 'cwd', draft.cwd, issues),
    labeledField('PURPOSE', 'purpose', draft.purpose, issues),
    labeledField('WORKSTREAM HINT', 'workstreamHint', draft.workstreamHint, issues),
  );
}

// ---------------------------------------------------------------------------
// Dispatch readout — an instrument state line, never a toast/spinner
// ---------------------------------------------------------------------------

export function dispatchReadoutView(state: LauncherState): VNode {
  const d = state.dispatch;
  const line = (text: string, tone: string, extra: Record<string, string> = {}): VNode =>
    h(
      'span',
      {
        'data-part': 'dispatch-readout',
        'data-phase': d.phase,
        ...extra,
        style: `${ENGRAVED_LABEL_STYLE} color: ${tone};`,
      },
      text,
    );
  switch (d.phase) {
    case 'idle':
      return line('READY', 'var(--ig-ink-muted)');
    case 'dispatching':
      // Loading doctrine §5: mono ellipsis in muted ink, never a spinner.
      return line('DISPATCHING …', 'var(--ig-ink-muted)');
    case 'accepted':
      return line(`SESSION ${d.sessionId}`, 'var(--ig-status-ok)', {
        'data-session': d.sessionId,
      });
    case 'refused':
      return line('REFUSED — CHECK FIELDS', 'var(--ig-status-fault)');
    case 'wire-error':
      return line(`FAULT ${d.error.code}`, 'var(--ig-status-fault)');
    case 'failed':
      return line(`FAULT ${d.note}`, 'var(--ig-status-fault)');
  }
}

// ---------------------------------------------------------------------------
// Launch history (local store)
// ---------------------------------------------------------------------------

export function launchHistoryView(entries: readonly LaunchHistoryEntry[]): VNode {
  const rows = entries.map((entry) =>
    h(
      'div',
      {
        'data-part': 'history-row',
        'data-outcome': entry.outcome,
        style:
          `${DATA_TEXT_STYLE} display: grid; ` +
          'grid-template-columns: 24ch 8ch 6ch 10ch 1fr; column-gap: var(--ig-grid-ch); ' +
          `min-height: var(--ig-grid-row); ${HAIRLINE_TOP}` +
          (entry.outcome === 'accepted'
            ? ' background: var(--ig-status-ok-tint);'
            : entry.outcome === 'wire-error'
              ? ' background: var(--ig-status-degraded-tint);'
              : ' background: var(--ig-status-fault-tint);'),
      },
      h('span', {}, new Date(entry.at).toISOString()),
      h('span', { 'data-history-label': entry.accountLabel }, entry.accountLabel),
      h('span', {}, entry.kind),
      h('span', {}, entry.outcome === 'wire-error' ? (entry.errorCode ?? 'wire-error') : entry.outcome),
      h('span', {}, entry.promptPreview),
    ),
  );

  return h(
    'div',
    { 'data-part': 'launch-history' },
    engraved('HISTORY'),
    entries.length === 0
      ? h('span', { style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-ink-faint);` }, 'EMPTY')
      : h(
          'button',
          {
            type: 'button',
            'data-action': 'clear-history',
            style: `${ENGRAVED_LABEL_STYLE} background: var(--ig-surface-panel); border: none; cursor: pointer;`,
          },
          'CLEAR',
        ),
    ...rows,
  );
}

// ---------------------------------------------------------------------------
// Panel composition
// ---------------------------------------------------------------------------

/** The full launch panel: picker, mode toggle, composer, readout, history. */
export function launchPanelView(
  state: LauncherState,
  detect: FeatureDetectSnapshot,
  history: readonly LaunchHistoryEntry[],
  catalog: SkillCatalogSlot = FREE_TEXT_CATALOG_SLOT,
): VNode {
  const issues = state.dispatch.phase === 'refused' ? state.dispatch.issues : [];
  const modeButton = (mode: LaunchMode, text: string): VNode =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': state.draft.mode === mode ? 'true' : 'false',
        'data-action': 'set-mode',
        'data-mode': mode,
        style:
          `${ENGRAVED_LABEL_STYLE} background: var(--ig-surface-panel); border: none; cursor: pointer; ` +
          `color: ${state.draft.mode === mode ? 'var(--ig-accent)' : 'var(--ig-ink-muted)'};`,
      },
      text,
    );

  return h(
    'section',
    {
      'data-part': 'launch-panel',
      style:
        'background: var(--ig-surface-panel); padding: var(--ig-space-16); ' +
        'font-family: var(--ig-font-mono);',
    },
    h(
      'h2',
      {
        style:
          'font-family: var(--ig-font-display); font-size: var(--ig-type-heading); ' +
          'line-height: var(--ig-type-heading-lh); color: var(--ig-ink-primary); margin: 0;',
      },
      'LAUNCH',
    ),
    accountPickerView(state.draft.account, detect, state.draft.mode),
    h(
      'div',
      { role: 'tablist', 'aria-label': 'LAUNCH MODE', 'data-part': 'mode-toggle' },
      modeButton('prompt', 'ONE-OFF PROMPT'),
      modeButton('skill', 'SKILL'),
    ),
    state.draft.mode === 'prompt'
      ? promptComposerView(state, issues)
      : skillComposerView(state, issues, detect, catalog),
    issues.some((i) => i.field === 'account')
      ? h(
          'span',
          {
            'data-issue': 'account',
            style: `${ENGRAVED_LABEL_STYLE} color: var(--ig-status-fault);`,
          },
          issues.find((i) => i.field === 'account')?.readout ?? '',
        )
      : undefined,
    h(
      'button',
      {
        type: 'button',
        'data-action': 'submit',
        'aria-disabled': state.dispatch.phase === 'dispatching' ? 'true' : 'false',
        style:
          'background: var(--ig-accent); color: var(--ig-ink-on-accent); border: none; ' +
          'border-radius: var(--ig-radius-1); font-family: var(--ig-font-mono); ' +
          'font-size: var(--ig-type-ui); line-height: var(--ig-type-ui-lh); ' +
          'padding: var(--ig-space-4) var(--ig-space-16); margin-top: var(--ig-space-12); ' +
          'cursor: pointer;',
      },
      'LAUNCH',
    ),
    dispatchReadoutView(state),
    launchHistoryView(history),
  );
}
