/**
 * FE account REGISTRY seam ([X1] scalability; ICR-0013 account-registry
 * generalization).
 *
 * THE PROBLEM this solves: the cockpit was built around a CLOSED five-label
 * set ({MAX_A, MAX_B, ENT, AWS_DEV, LOCAL}). The owner can provision
 * arbitrarily many Claude Max subscriptions on one machine (the keychain
 * isolation scales automatically — distinct CLAUDE_CONFIG_DIR → distinct
 * securestorage sha256 → distinct keychain item). This module is the ONE FE
 * source of truth for "which accounts does THIS machine have", so the picker,
 * the channel panels, and the observability/pipelines/workstreams account
 * chips all render N accounts instead of a hardcoded 5.
 *
 * TWO CONCEPTS, DELIBERATELY SEPARATED (mirrors vocab.ts):
 *
 *  (1) FIXED BACKEND LABELS — `AWS_DEV`, `LOCAL`. NOT accounts; each is the
 *      single stand-in for one backend substrate. The set is CLOSED, so these
 *      two ALWAYS appear, in a fixed tail position, regardless of the Claude
 *      account set.
 *
 *  (2) CLAUDE ACCOUNT LABELS — the OPEN, validated FORM (`^MAX_[A-Z]$` for Max
 *      accounts + the exact literal `ENT`). The runtime registry carries the
 *      Claude accounts actually provisioned on this machine. `MAX_C`, `MAX_D`,
 *      … are first-class sanctioned placeholders — admitted WITHOUT a code
 *      change, exactly like MAX_A/MAX_B.
 *
 * DISCOVERY SEAM ([X2] + interim, see below): the authoritative source is the
 * broker — the accounts it discovered from `infra/profiles/*.profile.json`.
 * ICR-0014 (docs/contracts/icr/icr-0014-fe-account-registry-surface.md)
 * requests the broker/bootstrap to carry the configured Claude-account label
 * list. Until that surface lands, the composition root calls
 * {@link setConfiguredClaudeAccounts} once at boot; absent that, the registry
 * falls back to the KNOWN/SEED three ({@link SEED_CLAUDE_ACCOUNTS}) — the
 * three originally provisioned placeholders. Either way, enumeration is driven
 * by DATA, never a hardcoded 5.
 *
 * [X2] AUDIT INVARIANT (preserved and extended): every label this module can
 * ever emit is a SANCTIONED PLACEHOLDER — a Claude label validated by
 * {@link isClaudeAccountLabel} (the `MAX_<X>`/`ENT` form) or one of the two
 * fixed backend labels. A raw identity (email, real account name, AWS id,
 * token) can NEVER become a registry entry: {@link buildAccountRegistry}
 * DROPS every non-form input, fail-closed. There is no code path by which
 * caller-supplied identity text reaches a rendered account name.
 */

import {
  ENTERPRISE_ACCOUNT_LABEL,
  FIXED_BACKEND_LABELS,
  backendForLabel,
  isClaudeAccountLabel,
  type Backend,
  type ClaudeAccountLabel,
  type FixedBackendLabel,
} from '@aibender/protocol';

/**
 * The KNOWN/SEED Claude accounts — the three originally provisioned
 * placeholders (MAX_A, MAX_B, ENT). Used as the fallback registry when neither
 * the broker surface nor {@link setConfiguredClaudeAccounts} has supplied the
 * live set. NOT a ceiling — the registry accepts any `MAX_<X>`/`ENT` form.
 */
export const SEED_CLAUDE_ACCOUNTS: readonly ClaudeAccountLabel[] = Object.freeze([
  'MAX_A',
  'MAX_B',
  ENTERPRISE_ACCOUNT_LABEL,
]);

/**
 * The fixed positional CHANNEL-HUE palette (DESIGN.md §2.5). These five
 * `--ig-channel-*` custom properties are the design system's channel index
 * hues (slate / sand / mint / rose / ash) — a FIXED palette owned by
 * tokens.ts (FE-1's locked source of truth). We assign them by SLOT POSITION,
 * not by hardcoded label: the ENGRAVED LABEL (MAX_C) is the account identity;
 * the hue is only the 2×16px positional index tick. A 4th/5th Claude account
 * reuses the Claude-hue slots by position — no new hue is invented, so
 * tokens.ts and DESIGN.md stay untouched (no lint:tokens regression, no FE-1
 * sign-off needed). See docs/adr/0001-dynamic-channel-panels.md.
 */
const CLAUDE_HUE_VARS: readonly string[] = Object.freeze([
  'var(--ig-channel-max-a)',
  'var(--ig-channel-max-b)',
  'var(--ig-channel-ent)',
]);

/** The two fixed backend labels' channel hues (never reassigned). */
const BACKEND_HUE_VAR: Readonly<Record<FixedBackendLabel, string>> = Object.freeze({
  AWS_DEV: 'var(--ig-channel-bedrock)',
  LOCAL: 'var(--ig-channel-lmstudio)',
});

/** Whether an entry is a Claude subscription account or a fixed backend. */
export type AccountKind = 'claude' | 'backend';

/**
 * One registry entry — a sanctioned placeholder label plus its derived
 * rendering metadata. Frozen; the label is guaranteed a placeholder.
 */
export interface AccountRegistryEntry {
  /** The placeholder label — a Claude `MAX_<X>`/`ENT` form or a backend label. */
  readonly label: ClaudeAccountLabel | FixedBackendLabel;
  /** Derived via the frozen label↔backend pairing; never caller-supplied. */
  readonly backend: Backend;
  /** Claude subscription account vs a fixed backend substrate. */
  readonly kind: AccountKind;
  /** 1-based render slot (Claude accounts first, then the two backends). */
  readonly slot: number;
  /**
   * Channel index-hue custom property (DESIGN.md §2.5 identity tick ONLY).
   * Assigned by slot position from the fixed five-hue palette.
   */
  readonly channelTokenVar: string;
}

/**
 * The full account registry: the configured Claude accounts (in order) then
 * the two fixed backend labels. Always at least the two backends; the Claude
 * count is 0..N.
 */
export interface AccountRegistry {
  readonly entries: readonly AccountRegistryEntry[];
  /** The Claude accounts only (kind === 'claude'), in slot order. */
  readonly claudeAccounts: readonly AccountRegistryEntry[];
  /** The two fixed backend entries, in slot order (AWS_DEV, LOCAL). */
  readonly backends: readonly AccountRegistryEntry[];
}

/**
 * Normalize an arbitrary configured-Claude-account input into the sanctioned,
 * de-duplicated, order-stable Claude-label list.
 *
 * FAIL-CLOSED per [X2]: any element that is not a sanctioned Claude form
 * ({@link isClaudeAccountLabel}) is DROPPED — an email, a real account name,
 * `HACKER`, `MAX_AB`, lowercase `max_c` never survive. Order is deterministic:
 * first-seen order of the accepted inputs (so a caller can express intent),
 * with duplicates removed. `ENT`, if present, is kept in its first-seen slot.
 */
export function normalizeClaudeAccounts(
  configured: Iterable<unknown>,
): readonly ClaudeAccountLabel[] {
  const seen = new Set<string>();
  const out: ClaudeAccountLabel[] = [];
  for (const value of configured) {
    if (!isClaudeAccountLabel(value)) continue; // [X2] drop non-form input
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return Object.freeze(out);
}

function claudeHueVarForSlot(index: number): string {
  // Reuse the fixed palette cyclically so the 4th/5th Claude account gets a
  // real token hue (never an off-token color). The label is the identity.
  const hue = CLAUDE_HUE_VARS[index % CLAUDE_HUE_VARS.length];
  return hue ?? (CLAUDE_HUE_VARS[0] as string);
}

/**
 * Build a frozen {@link AccountRegistry} from a configured Claude-account
 * list. The two fixed backend labels are ALWAYS appended (closed set). Every
 * entry's backend is derived via the frozen pairing; every hue is a token.
 *
 * The input is normalized fail-closed ({@link normalizeClaudeAccounts}); an
 * empty or all-garbage input yields a registry with zero Claude accounts and
 * the two backends — never a throw, never a raw identifier.
 */
export function buildAccountRegistry(configured: Iterable<unknown>): AccountRegistry {
  const claudeLabels = normalizeClaudeAccounts(configured);

  const claudeAccounts: AccountRegistryEntry[] = claudeLabels.map((label, index) =>
    Object.freeze({
      label,
      backend: backendForLabel(label),
      kind: 'claude' as const,
      slot: index + 1,
      channelTokenVar: claudeHueVarForSlot(index),
    }),
  );

  const backends: AccountRegistryEntry[] = FIXED_BACKEND_LABELS.map((label, index) =>
    Object.freeze({
      label,
      backend: backendForLabel(label),
      kind: 'backend' as const,
      slot: claudeAccounts.length + index + 1,
      channelTokenVar: BACKEND_HUE_VAR[label],
    }),
  );

  return Object.freeze({
    entries: Object.freeze([...claudeAccounts, ...backends]),
    claudeAccounts: Object.freeze(claudeAccounts),
    backends: Object.freeze(backends),
  });
}

// ---------------------------------------------------------------------------
// Module-level configured set (composition-root injection seam)
// ---------------------------------------------------------------------------

let configuredClaudeAccounts: readonly ClaudeAccountLabel[] = SEED_CLAUDE_ACCOUNTS;

/**
 * Set the live configured Claude-account list (the composition root calls this
 * ONCE at boot with the broker-surfaced set — ICR-0014 interim). Input is
 * normalized fail-closed. Passing nothing configured resets to the seed three.
 */
export function setConfiguredClaudeAccounts(configured: Iterable<unknown>): void {
  const normalized = normalizeClaudeAccounts(configured);
  configuredClaudeAccounts =
    normalized.length > 0 ? normalized : SEED_CLAUDE_ACCOUNTS;
}

/**
 * The currently-configured registry (seed three until the composition root
 * injects the broker set). This is the reader the picker / panels / decks
 * consume — they render whatever N accounts this returns, never a hardcoded 5.
 */
export function accountRegistry(): AccountRegistry {
  return buildAccountRegistry(configuredClaudeAccounts);
}

/** Test/composition helper: the current configured Claude-label list. */
export function currentConfiguredClaudeAccounts(): readonly ClaudeAccountLabel[] {
  return configuredClaudeAccounts;
}

/**
 * The channel index-hue token (`var(--ig-channel-*)`, DESIGN.md §2.5) for an
 * account label — for callers (pipelines/workstreams account chips) that key on
 * a label rather than iterating the registry. Prefers the label's slot in the
 * configured registry; a label NOT in the current registry (e.g. a step routed
 * to a not-yet-configured account) still gets a real token: fixed backends map
 * to their fixed hue, other Claude labels fall back to the first Claude hue.
 * NEVER returns a raw color. Total over any string; a non-form label reads as
 * the first Claude hue (identity tick only — the engraved label is authority).
 */
export function channelHueForLabel(label: AccountLabelLike): string {
  const registry = accountRegistry();
  const entry = registry.entries.find((e) => e.label === label);
  if (entry !== undefined) return entry.channelTokenVar;
  if (label === 'AWS_DEV') return BACKEND_HUE_VAR.AWS_DEV;
  if (label === 'LOCAL') return BACKEND_HUE_VAR.LOCAL;
  return CLAUDE_HUE_VARS[0] as string;
}

/** Widen import: any label-ish value the hue helper tolerates. */
type AccountLabelLike = ClaudeAccountLabel | FixedBackendLabel | string;
