/**
 * FE-5 feature-detect stub (plan §5/FE-5; blueprint §3 rule 6: "ENT is
 * feature-detected at runtime — managed policy may restrict headless use,
 * telemetry, workflows, models; the UI degrades per account").
 *
 * M2 slice: real runtime detection does not exist yet (it needs broker-side
 * probes), so this module is the SEAM — a snapshot shape the launcher renders
 * from, plus the stub every M2 composition uses. When detection lands, the
 * producer replaces the stub; the launcher's rendering rules do not change:
 *
 *   - the PICKER SLOT is retained (DESIGN.md §2.5 — instruments never
 *     disappear): a restricted account renders dimmed with an engraved
 *     RESTRICTED readout, never removed, never an error toast;
 *   - the restricted FEATURE SURFACE is hidden (plan §9.2 FE-5 negative row:
 *     "ENT-restricted feature hidden when feature-detect says so") — e.g. the
 *     skill composer for an account whose `skills` capability is off renders
 *     the NO SIGNAL treatment instead of an input;
 *   - submit is refused for a restricted (account, feature) pair regardless
 *     of what the DOM allowed (belt and braces — controller.ts).
 */

import { ACCOUNT_LABELS, isAccountLabel, type AccountLabel } from '@aibender/protocol';

export interface AccountCapabilities {
  /** Headless one-off SDK launches with a prompt (feature 2). */
  readonly oneOffPrompts: boolean;
  /** Skill launches — `/skill-name args` composition (feature 3). */
  readonly skills: boolean;
  /** Present iff something is restricted; drives the engraved readout. */
  readonly restrictedReason?: 'managed-policy' | 'undetected';
}

/** One capabilities row per frozen label — the map is total by construction. */
export type FeatureDetectSnapshot = Readonly<Record<AccountLabel, AccountCapabilities>>;

const FULLY_CAPABLE: AccountCapabilities = Object.freeze({
  oneOffPrompts: true,
  skills: true,
});

/**
 * The M2 stub: every account fully capable. Restrictions appear only when a
 * real detector reports them — nothing is hidden by default.
 */
export function stubFeatureDetect(): FeatureDetectSnapshot {
  const snapshot = {} as Record<AccountLabel, AccountCapabilities>;
  for (const label of ACCOUNT_LABELS) snapshot[label] = FULLY_CAPABLE;
  return Object.freeze(snapshot);
}

/**
 * Derive a snapshot with one account's capabilities replaced — how a detector
 * (or a test) expresses e.g. ENT-managed-policy degradation without mutating
 * the frozen stub.
 */
export function withAccountCapabilities(
  snapshot: FeatureDetectSnapshot,
  label: AccountLabel,
  capabilities: AccountCapabilities,
): FeatureDetectSnapshot {
  return Object.freeze({ ...snapshot, [label]: Object.freeze({ ...capabilities }) });
}

/**
 * Capability lookup that FAILS CLOSED: an unknown label (impossible via the
 * picker, representable only through tampered state) reads as fully
 * restricted rather than throwing mid-render or silently passing.
 */
export function capabilitiesFor(
  snapshot: FeatureDetectSnapshot,
  label: string,
): AccountCapabilities {
  if (!isAccountLabel(label)) {
    return { oneOffPrompts: false, skills: false, restrictedReason: 'undetected' };
  }
  return snapshot[label];
}

/** Is `feature` available for `label` under `snapshot`? Fail-closed. */
export function featureAvailable(
  snapshot: FeatureDetectSnapshot,
  label: string,
  feature: 'oneOffPrompts' | 'skills',
): boolean {
  return capabilitiesFor(snapshot, label)[feature];
}
