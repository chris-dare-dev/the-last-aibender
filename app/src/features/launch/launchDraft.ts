/**
 * FE-5 launch drafts — form state → frozen `LaunchParams` (ws-protocol §4.1).
 *
 * Client-side validation mirrors the FROZEN `validateControlRequest` rules
 * (absolute cwd, non-empty purpose, non-empty prompt when present) and is
 * deliberately STRICTER in two launcher-specific ways:
 *   - the one-off launcher REQUIRES a prompt (a one-off launch without a
 *     prompt is meaningless even though the wire allows it — feature 2);
 *   - whitespace-only text is refused (the wire only checks length > 0).
 *
 * Pairing violations the golden corpus rejects on the wire
 * (`control-launch-label-backend-mismatch`, `control-launch-pty-non-claude`)
 * are UNREPRESENTABLE here: backend derives from the frozen label↔backend
 * pairing (`backendForLabel`) and the M2 one-off/skill slice pins substrate
 * `sdk` (both features are headless; attended PTY launches are a different
 * surface).
 */

import {
  backendForLabel,
  isAccountLabel,
  type AccountLabel,
  type LaunchParams,
} from '@aibender/protocol';

import { featureAvailable, type FeatureDetectSnapshot } from './featureDetect.ts';
import { composeSkillPrompt, parseSkillCommand, type SkillCatalogSlot } from './skill.ts';

export type LaunchMode = 'prompt' | 'skill';

/** Raw launcher form state (all free text except the account selection). */
export interface LaunchDraft {
  readonly mode: LaunchMode;
  readonly account: AccountLabel;
  readonly cwd: string;
  readonly purpose: string;
  /** One-off prompt text (mode 'prompt'). */
  readonly prompt: string;
  /** `/skill-name args` text (mode 'skill'). */
  readonly skillText: string;
  readonly workstreamHint: string;
}

export type DraftField = 'account' | 'cwd' | 'purpose' | 'prompt' | 'skillText' | 'workstreamHint';

export interface DraftIssue {
  readonly field: DraftField;
  /** Terse engraved readout (instrument voice). */
  readonly readout: string;
}

export type DraftValidation =
  | { readonly ok: true; readonly params: LaunchParams }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

const issue = (field: DraftField, readout: string): DraftIssue => Object.freeze({ field, readout });

/**
 * Validate a draft against the frozen wire rules + launcher policy + the
 * feature-detect snapshot. Returns wire-ready `LaunchParams` (keys in the
 * exact golden-corpus order — wire.spec.ts pins the bytes) or the full issue
 * list for the composer readouts.
 */
export function validateLaunchDraft(
  draft: LaunchDraft,
  detect: FeatureDetectSnapshot,
  catalog?: SkillCatalogSlot,
): DraftValidation {
  const issues: DraftIssue[] = [];

  if (!isAccountLabel(draft.account)) {
    // Unrepresentable via the picker; reachable only through tampered state.
    issues.push(issue('account', 'UNKNOWN ACCOUNT'));
  } else {
    const feature = draft.mode === 'prompt' ? 'oneOffPrompts' : 'skills';
    if (!featureAvailable(detect, draft.account, feature)) {
      issues.push(issue('account', 'RESTRICTED'));
    }
  }

  const cwd = draft.cwd.trim();
  if (cwd.length === 0 || !cwd.startsWith('/')) {
    issues.push(issue('cwd', 'ABSOLUTE PATH REQUIRED'));
  }

  let prompt = '';
  if (draft.mode === 'prompt') {
    prompt = draft.prompt.trim().length === 0 ? '' : draft.prompt;
    if (prompt.length === 0) issues.push(issue('prompt', 'PROMPT REQUIRED'));
  } else {
    const parsed = parseSkillCommand(draft.skillText, catalog);
    if (!parsed.ok) {
      issues.push(issue('skillText', 'INVALID SKILL COMMAND'));
    } else {
      prompt = composeSkillPrompt(parsed.value);
    }
  }

  // Skill mode derives a purpose when the field is blank (documented, tested).
  let purpose = draft.purpose.trim();
  if (purpose.length === 0 && draft.mode === 'skill' && prompt.length > 0) {
    purpose = `skill ${prompt.split(/\s/, 1)[0] ?? ''}`.trim();
  }
  if (purpose.length === 0) issues.push(issue('purpose', 'PURPOSE REQUIRED'));

  const workstreamHint = draft.workstreamHint.trim();

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };

  // Key insertion order MUST match the golden corpus frames:
  // accountLabel, backend, substrate, cwd, purpose[, workstreamHint][, prompt]
  const params: LaunchParams = {
    accountLabel: draft.account,
    // `draft.account` passed `isAccountLabel` above, so the pairing is total.
    backend: backendForLabel(draft.account),
    substrate: 'sdk',
    cwd,
    purpose,
    ...(workstreamHint.length > 0 ? { workstreamHint } : {}),
    ...(prompt.length > 0 ? { prompt } : {}),
  };
  return { ok: true, params };
}

/** An empty draft with launcher defaults (prompt mode, MAX_A slot 1). */
export function emptyLaunchDraft(): LaunchDraft {
  return {
    mode: 'prompt',
    account: 'MAX_A',
    cwd: '',
    purpose: '',
    prompt: '',
    skillText: '',
    workstreamHint: '',
  };
}
