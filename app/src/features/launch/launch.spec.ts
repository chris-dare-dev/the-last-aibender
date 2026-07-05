/**
 * FE-5 launcher core tests — picker derivation, feature detection, skill
 * composition, draft validation (plan §9.2 FE-5 rows, M2 slice).
 *
 *  positive — five options in frozen slot order; skill parse/compose
 *             round-trips; drafts validate to wire-legal params;
 *  negative — restricted accounts refused; malformed skill commands refused;
 *             wire-illegal drafts refused with per-field readouts;
 *  edge     — args length cap boundary; whitespace-only text; derived skill
 *             purpose; unknown labels fail closed.
 */

import { describe, expect, it } from 'vitest';

import { ACCOUNT_LABELS, backendForLabel, type AccountLabel } from '@aibender/protocol';

import { buildAccountRegistry } from '../../lib/accountRegistry.ts';
import { accountPickerOptions } from './accounts.ts';
import {
  capabilitiesFor,
  featureAvailable,
  stubFeatureDetect,
  withAccountCapabilities,
} from './featureDetect.ts';
import { emptyLaunchDraft, validateLaunchDraft, type LaunchDraft } from './launchDraft.ts';
import {
  FREE_TEXT_CATALOG_SLOT,
  MAX_SKILL_ARGS_CHARS,
  composeSkillPrompt,
  parseSkillCommand,
  skillIssueReadout,
  type SkillCatalogSlot,
} from './skill.ts';

const detect = stubFeatureDetect();

const validPromptDraft = (account: AccountLabel = 'MAX_A'): LaunchDraft => ({
  ...emptyLaunchDraft(),
  account,
  cwd: '/synthetic/workspace',
  purpose: 'launcher test',
  prompt: 'synthesized one-off prompt',
});

// ---------------------------------------------------------------------------
// Account picker derivation
// ---------------------------------------------------------------------------

describe('accountPickerOptions (positive)', () => {
  it('offers the configured registry + the two backend labels, in slot order (seed = 5)', () => {
    // [X1] the DEFAULT registry (seed three Claude + two backends) still renders
    // the same five options in the same order as the pre-ICR-0013 build.
    const options = accountPickerOptions();
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.label)).toEqual([...ACCOUNT_LABELS]);
    expect(options.map((o) => o.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([
    ['3-Claude', ['MAX_A', 'MAX_B', 'ENT'], 5],
    ['4-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C'], 6],
    ['5-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D'], 7],
  ])(
    'renders N Claude accounts + the two backends for a %s registry',
    (_n, claude, total) => {
      const options = accountPickerOptions(buildAccountRegistry(claude));
      expect(options).toHaveLength(total);
      // Claude accounts first (registry order), then the two fixed backends.
      expect(options.map((o) => o.label)).toEqual([...claude, 'AWS_DEV', 'LOCAL']);
      expect(options.map((o) => o.slot)).toEqual(
        Array.from({ length: total }, (_v, i) => i + 1),
      );
    },
  );

  it('derives every backend from the frozen pairing (any N)', () => {
    const options = accountPickerOptions(
      buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']),
    );
    for (const option of options) {
      expect(option.backend).toBe(backendForLabel(option.label));
    }
  });

  it('references channel index hues as tokens only, for any N (never a raw color)', () => {
    const options = accountPickerOptions(
      buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']),
    );
    for (const option of options) {
      expect(option.channelTokenVar).toMatch(/^var\(--ig-channel-[a-z-]+\)$/);
    }
  });

  it('returns frozen data — options cannot be mutated into other labels', () => {
    const options = accountPickerOptions();
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

describe('featureDetect', () => {
  it('stub reports every account fully capable (nothing hidden by default)', () => {
    for (const label of ACCOUNT_LABELS) {
      expect(featureAvailable(detect, label, 'oneOffPrompts')).toBe(true);
      expect(featureAvailable(detect, label, 'skills')).toBe(true);
    }
  });

  it('withAccountCapabilities degrades one account without mutating the stub', () => {
    const degraded = withAccountCapabilities(detect, 'ENT', {
      oneOffPrompts: false,
      skills: false,
      restrictedReason: 'managed-policy',
    });
    expect(featureAvailable(degraded, 'ENT', 'skills')).toBe(false);
    expect(featureAvailable(detect, 'ENT', 'skills')).toBe(true);
    expect(featureAvailable(degraded, 'MAX_A', 'skills')).toBe(true);
  });

  it('fails closed for unknown labels (tampered state never gains capability)', () => {
    const capabilities = capabilitiesFor(detect, 'NOT_A_LABEL');
    expect(capabilities.oneOffPrompts).toBe(false);
    expect(capabilities.skills).toBe(false);
    expect(capabilities.restrictedReason).toBe('undetected');
  });
});

// ---------------------------------------------------------------------------
// Skill composition
// ---------------------------------------------------------------------------

describe('parseSkillCommand (positive)', () => {
  it('parses name and args', () => {
    expect(parseSkillCommand('/deep-research quantum error correction')).toEqual({
      ok: true,
      value: { name: 'deep-research', args: 'quantum error correction' },
    });
  });

  it('parses a bare command and a namespaced name; tolerates surrounding whitespace', () => {
    expect(parseSkillCommand('  /code-review  ')).toEqual({
      ok: true,
      value: { name: 'code-review' },
    });
    expect(parseSkillCommand('/anthropic-skills:pdf merge a b')).toEqual({
      ok: true,
      value: { name: 'anthropic-skills:pdf', args: 'merge a b' },
    });
  });

  it('validates against a catalog when the slot provides one', () => {
    const catalog: SkillCatalogSlot = { list: () => [{ name: 'deep-research' }] };
    expect(parseSkillCommand('/deep-research x', catalog).ok).toBe(true);
    expect(parseSkillCommand('/unknown-skill x', catalog)).toEqual({
      ok: false,
      issue: 'unknown-skill',
    });
  });
});

describe('parseSkillCommand (negative/edge)', () => {
  it('refuses empty, slashless, and malformed names', () => {
    expect(parseSkillCommand('')).toEqual({ ok: false, issue: 'empty' });
    expect(parseSkillCommand('   ')).toEqual({ ok: false, issue: 'empty' });
    expect(parseSkillCommand('deep-research x')).toEqual({ ok: false, issue: 'missing-slash' });
    expect(parseSkillCommand('/Bad_Name x')).toEqual({ ok: false, issue: 'bad-name' });
    expect(parseSkillCommand('/-leading-dash')).toEqual({ ok: false, issue: 'bad-name' });
    expect(parseSkillCommand('/a:b:c')).toEqual({ ok: false, issue: 'bad-name' });
    expect(parseSkillCommand('/')).toEqual({ ok: false, issue: 'bad-name' });
  });

  it('caps args length at the boundary (4096 ok, 4097 refused)', () => {
    const atCap = `/skill ${'a'.repeat(MAX_SKILL_ARGS_CHARS)}`;
    const overCap = `/skill ${'a'.repeat(MAX_SKILL_ARGS_CHARS + 1)}`;
    expect(parseSkillCommand(atCap).ok).toBe(true);
    expect(parseSkillCommand(overCap)).toEqual({ ok: false, issue: 'args-too-long' });
  });

  it('free-text slot reports no catalog (M2) so unknown names pass shape-only', () => {
    expect(FREE_TEXT_CATALOG_SLOT.list()).toBeUndefined();
    expect(parseSkillCommand('/never-catalogued').ok).toBe(true);
  });

  it('readouts are total over the issue union', () => {
    for (const issue of ['empty', 'missing-slash', 'bad-name', 'args-too-long', 'unknown-skill'] as const) {
      expect(skillIssueReadout(issue).length).toBeGreaterThan(0);
    }
  });
});

describe('composeSkillPrompt', () => {
  it('composes /name and /name args; round-trips through the parser', () => {
    expect(composeSkillPrompt({ name: 'code-review' })).toBe('/code-review');
    expect(composeSkillPrompt({ name: 'deep-research', args: 'topic x' })).toBe(
      '/deep-research topic x',
    );
    const parsed = parseSkillCommand(composeSkillPrompt({ name: 'a-b', args: 'c d' }));
    expect(parsed).toEqual({ ok: true, value: { name: 'a-b', args: 'c d' } });
  });

  it('throws on a name the parser could never produce (programmer error)', () => {
    expect(() => composeSkillPrompt({ name: 'Bad Name' })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

describe('validateLaunchDraft (positive)', () => {
  it('validates a one-off prompt draft to wire-legal params for every label', () => {
    for (const label of ACCOUNT_LABELS) {
      const verdict = validateLaunchDraft(validPromptDraft(label), detect);
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.params.accountLabel).toBe(label);
        expect(verdict.params.prompt).toBe('synthesized one-off prompt');
        expect(verdict.params.workstreamHint).toBeUndefined();
      }
    }
  });

  it('keeps prompt text verbatim (internal formatting preserved)', () => {
    const verdict = validateLaunchDraft(
      { ...validPromptDraft(), prompt: 'line one\n  indented two\n' },
      detect,
    );
    expect(verdict.ok && verdict.params.prompt).toBe('line one\n  indented two\n');
  });

  it('includes workstreamHint only when non-blank; trims cwd/purpose', () => {
    const verdict = validateLaunchDraft(
      {
        ...validPromptDraft(),
        cwd: '  /synthetic/workspace  ',
        purpose: '  padded purpose  ',
        workstreamHint: '  ws_hint_1  ',
      },
      detect,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.params.cwd).toBe('/synthetic/workspace');
      expect(verdict.params.purpose).toBe('padded purpose');
      expect(verdict.params.workstreamHint).toBe('ws_hint_1');
    }
  });

  it('composes a skill draft into a /skill prompt and derives a blank purpose', () => {
    const verdict = validateLaunchDraft(
      {
        ...emptyLaunchDraft(),
        mode: 'skill',
        account: 'MAX_B',
        cwd: '/synthetic/workspace',
        skillText: '/deep-research topic x',
      },
      detect,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.params.prompt).toBe('/deep-research topic x');
      expect(verdict.params.purpose).toBe('skill /deep-research');
      expect(verdict.params.backend).toBe('claude_code');
    }
  });
});

describe('validateLaunchDraft (negative)', () => {
  it('refuses a missing prompt in prompt mode (launcher-required, wire-optional)', () => {
    const verdict = validateLaunchDraft({ ...validPromptDraft(), prompt: '   ' }, detect);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.issues.map((i) => i.field)).toContain('prompt');
    }
  });

  it('refuses a relative cwd (golden control-launch-relative-cwd class)', () => {
    const verdict = validateLaunchDraft({ ...validPromptDraft(), cwd: 'relative/path' }, detect);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.map((i) => i.field)).toContain('cwd');
  });

  it('refuses a restricted account for the active mode with a RESTRICTED readout', () => {
    const degraded = withAccountCapabilities(detect, 'ENT', {
      oneOffPrompts: false,
      skills: false,
      restrictedReason: 'managed-policy',
    });
    const verdict = validateLaunchDraft(validPromptDraft('ENT'), degraded);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const account = verdict.issues.find((i) => i.field === 'account');
      expect(account?.readout).toBe('RESTRICTED');
    }
  });

  it('refuses an unknown account label (tampered state fails closed)', () => {
    const verdict = validateLaunchDraft(
      { ...validPromptDraft(), account: 'REAL_NAME' as AccountLabel },
      detect,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.map((i) => i.field)).toContain('account');
  });

  it('collects every issue in one pass (empty draft reports all failing fields)', () => {
    const verdict = validateLaunchDraft(emptyLaunchDraft(), detect);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const fields = verdict.issues.map((i) => i.field);
      expect(fields).toContain('cwd');
      expect(fields).toContain('purpose');
      expect(fields).toContain('prompt');
    }
  });

  it('refuses an invalid skill command in skill mode', () => {
    const verdict = validateLaunchDraft(
      { ...emptyLaunchDraft(), mode: 'skill', cwd: '/synthetic/workspace', skillText: 'no-slash' },
      detect,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.map((i) => i.field)).toContain('skillText');
  });
});
