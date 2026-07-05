/**
 * Wire vocabularies shared by every channel and by @aibender/schema account
 * validation. Labels are placeholders ONLY per [X2]. Real identity mapping is
 * machine-local (@aibender/shared identity map) and never enters the repo or
 * any wire message.
 *
 * TWO CONCEPTS, DELIBERATELY SEPARATED (ICR-0013, [X1] scalability):
 *
 *  (1) FIXED BACKEND LABELS — `AWS_DEV`, `LOCAL`. These are NOT Claude
 *      subscription accounts; each is the single stand-in for one backend
 *      substrate (AWS_DEV → OpenCode→Bedrock, LOCAL → LM Studio). The set is
 *      CLOSED — a new one would be a new backend, an ICR of its own.
 *
 *  (2) CLAUDE ACCOUNT LABELS — an OPEN, VALIDATED FORM, because the owner can
 *      provision arbitrarily many Claude Max subscriptions on one machine (the
 *      keychain isolation scales automatically: distinct CLAUDE_CONFIG_DIR →
 *      distinct securestorage sha256 → distinct keychain item). The sanctioned
 *      form is:
 *
 *          {@link CLAUDE_ACCOUNT_LABEL_RE} = /^MAX_[A-Z]$/   (Max accounts)
 *          plus the exact literal 'ENT'                       (enterprise/work)
 *
 *      So `MAX_A`, `MAX_B`, `MAX_C`, `MAX_D`, … `MAX_Z` are all first-class
 *      sanctioned placeholders (SECURITY.md §1, .gitleaks.toml header). WIRE
 *      and SCHEMA VALIDATION accept the form; UI ENUMERATION renders the
 *      runtime REGISTRY of accounts actually provisioned on THIS machine
 *      (discovered from infra/profiles/*.profile.json) — never a hardcoded
 *      count. `ENT` stays a single exact literal, minimal and [X2]-sanctioned;
 *      a future `ENT_x` form would be its own ICR.
 *
 * {@link ACCOUNT_LABELS} remains as a KNOWN/SEED list (the 5 originally
 * provisioned placeholders) for back-compat, DB seeding, and tests — but it is
 * NO LONGER the validation ceiling. {@link isAccountLabel} keys off the FORM,
 * not membership in that array.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04), AMENDED at FROZEN-M7 (2026-07-05) via
 * ICR-0013 (docs/contracts/icr/icr-0013-account-registry.md): the account-label
 * CLOSED-set membership check was widened to the validated FORM above, and
 * LABEL_BACKENDS (a Record) became {@link backendForLabel} (a function). This
 * is a validation-WIDENING additive change — every previously-valid label is
 * still valid, the label↔backend pairing invariant is preserved, and no wire
 * SHAPE changed. Further amendments only via ICR; BE-ORCH lands, FE-ORCH
 * co-signs. Prose of record: docs/contracts/ws-protocol.md §4.1.
 * ============================================================================
 */

/**
 * The KNOWN/SEED account labels — the 5 originally provisioned placeholders.
 *
 * This is a back-compat + seeding + test convenience, NOT the validation
 * ceiling. New Claude accounts (MAX_C, MAX_D, …) are valid by FORM
 * ({@link isAccountLabel}) without appearing here. The DB seed (migration 0001)
 * and the FE picker's runtime registry both derive their live set elsewhere;
 * this array is the historical baseline.
 */
export const ACCOUNT_LABELS = Object.freeze([
  'MAX_A',
  'MAX_B',
  'ENT',
  'AWS_DEV',
  'LOCAL',
] as const);

/**
 * The FIXED backend labels: `AWS_DEV` and `LOCAL`. Closed set — not Claude
 * accounts, each is the single stand-in for one backend substrate.
 */
export const FIXED_BACKEND_LABELS = Object.freeze(['AWS_DEV', 'LOCAL'] as const);

export type FixedBackendLabel = (typeof FIXED_BACKEND_LABELS)[number];

/**
 * The sanctioned FORM for a Claude MAX account label: `MAX_` followed by a
 * single uppercase ASCII letter (A–Z). This is the [X2] sanctioned-placeholder
 * pattern for Max accounts (mirrored in SECURITY.md §1 and the .gitleaks.toml
 * header). Anchored — a label must match end-to-end, so `MAX_`, `MAX_AB`,
 * `MAX_a`, `MAX_1`, and `hacker@example.com` all FAIL.
 */
export const CLAUDE_ACCOUNT_LABEL_RE = /^MAX_[A-Z]$/;

/** The enterprise/work Claude account: a single exact sanctioned literal. */
export const ENTERPRISE_ACCOUNT_LABEL = 'ENT' as const;

export type EnterpriseAccountLabel = typeof ENTERPRISE_ACCOUNT_LABEL;

/** A Claude subscription account label: a MAX_<X> Max account, or `ENT`. */
export type ClaudeAccountLabel = `MAX_${string}` | EnterpriseAccountLabel;

/**
 * An account label the harness accepts: either a Claude account (open, validated
 * by {@link CLAUDE_ACCOUNT_LABEL_RE} / `ENT`) or a fixed backend label. The
 * `` `MAX_${string}` `` member is a structural approximation of the runtime
 * regex — {@link isAccountLabel} is the authoritative gate (it enforces the
 * single-uppercase-letter shape the type cannot express).
 */
export type AccountLabel = ClaudeAccountLabel | FixedBackendLabel;

/** Session backends (blueprint §5 `session_node.backend`). */
export const BACKENDS = Object.freeze(['claude_code', 'opencode', 'lmstudio'] as const);

export type Backend = (typeof BACKENDS)[number];

/**
 * Execution substrates (blueprint §4.1): SDK `query()` is the only
 * programmatic substrate; node-pty is the only attended surface, and it is
 * Claude-only (OpenCode is a supervised server, LM Studio is an API).
 */
export const SUBSTRATES = Object.freeze(['sdk', 'pty'] as const);

export type Substrate = (typeof SUBSTRATES)[number];

/**
 * Resume-ledger session states as they appear on the wire (`status` verb).
 * The storage-side legal-transition map lives in @aibender/schema; the state
 * machine itself is prototyped and validated in SPIKE-D (vii)
 * (docs/spikes/spike-d-pty-supervision.md) and specified in
 * docs/contracts/sqlite-ddl.md.
 */
export const SESSION_STATES = Object.freeze([
  'spawning',
  'running',
  'resumed',
  'orphan_detected',
  'orphan_killed',
  'exited',
] as const);

export type SessionState = (typeof SESSION_STATES)[number];

/** True for a fixed backend label (`AWS_DEV` | `LOCAL`). */
export function isFixedBackendLabel(value: unknown): value is FixedBackendLabel {
  return typeof value === 'string' && (FIXED_BACKEND_LABELS as readonly string[]).includes(value);
}

/**
 * True for a Claude subscription account label: a `MAX_<X>` Max account
 * (single uppercase letter) or the exact enterprise literal `ENT`. This is the
 * OPEN, validated form — `MAX_C`/`MAX_D`/… are accepted without a code change.
 */
export function isClaudeAccountLabel(value: unknown): value is ClaudeAccountLabel {
  return (
    typeof value === 'string' &&
    (value === ENTERPRISE_ACCOUNT_LABEL || CLAUDE_ACCOUNT_LABEL_RE.test(value))
  );
}

/**
 * The account-label gate. True iff `value` is a sanctioned Claude account form
 * ({@link isClaudeAccountLabel}) OR a fixed backend label
 * ({@link isFixedBackendLabel}). This REPLACES the old closed-array membership
 * check — the form, not a hardcoded set of 5, is the validation ceiling. A
 * non-sanctioned label (`HACKER`, an email-shaped string, `MAX_AB`, `max_a`)
 * is still REJECTED, so the form is a real gate, not anything-goes.
 */
export function isAccountLabel(value: unknown): value is AccountLabel {
  return isClaudeAccountLabel(value) || isFixedBackendLabel(value);
}

export function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && (BACKENDS as readonly string[]).includes(value);
}

export function isSubstrate(value: unknown): value is Substrate {
  return typeof value === 'string' && (SUBSTRATES as readonly string[]).includes(value);
}

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}

/**
 * Thrown by {@link backendForLabel} when handed a label outside the sanctioned
 * account-label form — the typed-refusal convention (callers that reach here
 * have already skipped the {@link isAccountLabel} gate).
 */
export class UnknownAccountLabelError extends Error {
  override readonly name = 'UnknownAccountLabelError';
  constructor(label: unknown) {
    super(`unknown account label ${JSON.stringify(label)} (not a sanctioned MAX_<X>/ENT/fixed-backend form)`);
  }
}

/**
 * The one legal backend per account label (blueprint §3/§4). REPLACES the old
 * `LABEL_BACKENDS` Record so the open Claude-account form works: any `MAX_<X>`
 * Max account and `ENT` ride `claude_code`; `AWS_DEV` rides OpenCode; `LOCAL`
 * is LM Studio. A launch that violates this pairing is rejected at validation.
 *
 * Throws {@link UnknownAccountLabelError} on a label outside the sanctioned
 * form — validators call {@link isAccountLabel} first, so an unknown label
 * here is a programmer error, not wire data.
 */
export function backendForLabel(label: AccountLabel): Backend {
  if (isClaudeAccountLabel(label)) return 'claude_code';
  if (label === 'AWS_DEV') return 'opencode';
  if (label === 'LOCAL') return 'lmstudio';
  throw new UnknownAccountLabelError(label);
}

/**
 * Total variant of {@link backendForLabel}: returns `undefined` (never throws)
 * for a label outside the sanctioned form. For call sites that already hold an
 * `unknown` and want a single-expression pairing check.
 */
export function backendForLabelOrUndefined(label: unknown): Backend | undefined {
  return isAccountLabel(label) ? backendForLabel(label) : undefined;
}
