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
 *
 * AMENDED again at FROZEN-M8 (2026-07-05) via ICR-0016
 * (docs/contracts/icr/icr-0016-backend-registry.md): the BACKEND twin of the
 * ICR-0013 account-registry problem. Before this amendment {@link BACKENDS} was
 * a CLOSED frozen 3-tuple and {@link isBackend} tested membership in it; adding
 * a fourth local LLM / backend was a cross-codebase fork (~42 literal branch
 * sites + a new schema migration). This amendment introduces a
 * {@link BackendDescriptor} + a registry ({@link registerBackend} /
 * {@link backendById} / {@link allBackends}), pre-populated with the three
 * built-ins as descriptors. {@link isBackend} now validates membership in the
 * REGISTRY (built-ins + any registered), {@link backendForLabel} /
 * {@link isAccountLabel} resolve through the descriptors' account-label
 * predicates, and the events `source` a backend feeds comes from its descriptor
 * ({@link sourceForBackend}). {@link BACKENDS} remains a KNOWN/SEED list for
 * back-compat + tests but is NO LONGER the validation ceiling — mirroring how
 * ICR-0013 kept {@link ACCOUNT_LABELS} as a seed. Behaviour for the three
 * built-ins is BYTE-IDENTICAL (same ids, same pairing, same sources, same
 * substrate rules). Adding a backend is one descriptor +
 * {@link registerBackend} call, NOT ~42 edits. Validation-WIDENING additive;
 * further amendments only via ICR. Prose of record: docs/contracts/ws-protocol.md
 * §4.1 (backend vocabulary) + docs/contracts/sqlite-ddl.md.
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

/**
 * The KNOWN/SEED session backends (blueprint §5 `session_node.backend`) — the
 * three built-ins provisioned from day one.
 *
 * Like {@link ACCOUNT_LABELS} after ICR-0013, this is a back-compat + seeding +
 * test convenience, NOT the validation ceiling (ICR-0016). A fourth backend
 * registered via {@link registerBackend} is valid ({@link isBackend}) without
 * appearing here. The {@link Backend} TYPE stays the seed union so the many
 * compile-time call sites that switch on the literal three keep exhaustiveness;
 * a registered id widens the RUNTIME set only. Never reorder this seed (the
 * golden corpus + schema seed rows key on it).
 */
export const BACKENDS = Object.freeze(['claude_code', 'opencode', 'lmstudio'] as const);

/**
 * A session backend id. The TYPE is the seed union of the three built-ins — the
 * value a descriptor with one of those ids carries and the value TS call sites
 * exhaustively switch on. A backend REGISTERED at runtime (ICR-0016) has an id
 * that is a `string` not statically in this union; {@link isBackend} is the
 * authoritative runtime gate (it admits the registry, not just the seed), and
 * {@link BackendId} is the widened string alias for descriptor-driven code.
 */
export type Backend = (typeof BACKENDS)[number];

/**
 * A backend id as a widened string — the type a registry-driven consumer holds
 * when it does not care whether the id is one of the seed three or a
 * registered fourth. {@link Backend} narrows this to the compile-time three.
 */
export type BackendId = string;

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
 * ({@link isClaudeAccountLabel}), a fixed backend label
 * ({@link isFixedBackendLabel}), OR a label served by a REGISTERED backend
 * descriptor (ICR-0016 — e.g. a fourth local LLM declaring its own label form).
 * This REPLACES the old closed-array membership check — the form + registry,
 * not a hardcoded set of 5, is the validation ceiling. A non-sanctioned label
 * (`HACKER`, an email-shaped string, `MAX_AB`, `max_a`) served by NO backend is
 * still REJECTED, so this is a real gate, not anything-goes.
 *
 * Byte-identical for the built-in three: `isClaudeAccountLabel`/
 * `isFixedBackendLabel` remain authoritative for their forms; the registry
 * branch can only ADD labels a future descriptor declares.
 */
export function isAccountLabel(value: unknown): value is AccountLabel {
  if (isClaudeAccountLabel(value) || isFixedBackendLabel(value)) return true;
  return typeof value === 'string' && registeredBackendServingLabel(value) !== undefined;
}

/**
 * True iff `value` is a REGISTERED backend id (ICR-0016). This REPLACES the old
 * closed `BACKENDS`-array membership check — the registry (the three built-ins
 * pre-populated + any {@link registerBackend}'d descriptor), not the frozen
 * 3-tuple, is the validation ceiling. Byte-identical for the built-in three
 * (they are pre-registered), and a synthetic/added fourth backend now validates
 * without a code edit. An unregistered/garbage id is still REJECTED, so the
 * registry is a REAL gate.
 *
 * The narrowed type is {@link Backend} (the seed union) for ergonomics at the
 * many built-in call sites; a registered id is a `string` at runtime that this
 * predicate still accepts — see {@link BackendId} for the widened alias.
 */
export function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && BACKEND_REGISTRY.has(value);
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
  // Built-in resolution FIRST, verbatim — byte-identical for the three, and it
  // guarantees a descriptor can never shadow a built-in label's backend.
  if (isClaudeAccountLabel(label)) return 'claude_code';
  if (label === 'AWS_DEV') return 'opencode';
  if (label === 'LOCAL') return 'lmstudio';
  // ICR-0016: a label served by a registered (non-built-in) descriptor resolves
  // to that descriptor's backend id, so a fourth backend routes with no branch
  // edit here. The `as Backend` widening is honest: `Backend` is the seed union
  // but a registered id is a runtime string the callers treat opaquely.
  const descriptor = registeredBackendServingLabel(label);
  if (descriptor !== undefined) return descriptor.id as Backend;
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

// ===========================================================================
// Backend registry (ICR-0016) — the BACKEND twin of the ICR-0013 account
// registry. A BackendDescriptor declares everything the dispatch seams need to
// route a backend WITHOUT literal-equality branches; the three built-ins are
// pre-registered as descriptors with BYTE-IDENTICAL behaviour, and a fourth is
// one registerBackend() call.
// ===========================================================================

/**
 * Everything the cross-codebase dispatch needs to know about ONE backend, so
 * that adding a new local LLM / backend is a data change (one descriptor) not a
 * ~42-site fork. The built-in three are pre-registered (see {@link BACKENDS}).
 *
 * The seams a descriptor declares:
 *   - {@link id}          the wire/DB backend literal (`session_node.backend`,
 *                         `events.backend`, etc.). Unique across the registry.
 *   - {@link servesLabel} the account-label predicate this backend serves — the
 *                         BACKEND-side of the label↔backend pairing. Any label
 *                         for which this returns true pairs with {@link id} in
 *                         {@link backendForLabel}. MUST NOT overlap the built-in
 *                         label forms (registerBackend enforces this) so a
 *                         descriptor can never hijack a built-in label.
 *   - {@link sourceName}  the events-store `source` a step on this backend feeds
 *                         (the {@link sourceForBackend} resolution). Keeps the
 *                         events pane truthful; must be a value the events
 *                         `source` vocabulary admits.
 *   - {@link substrates}  the execution substrates legal for this backend. Used
 *                         by the pty-is-claude-only style rules — a backend that
 *                         omits `'pty'` may not run an attended session. The
 *                         built-in default is `['sdk']`; only `claude_code`
 *                         lists `'pty'`.
 *   - {@link builtin}     true for the three seed backends (they carry the
 *                         authoritative built-in label forms and may not be
 *                         re-registered / removed).
 *
 * The adapter-factory + health-probe HOOKS the design calls for are declared as
 * OPTIONAL, backend-agnostic slots ({@link adapterFactoryKey},
 * {@link healthProbeKey}) that the BE-4/kernel lanes resolve out-of-band (they
 * own adapter construction; the protocol package must stay dependency-free and
 * cannot hold a live adapter). A descriptor names WHICH adapter/probe it wants
 * by a stable key; the core composition root maps the key to the concrete
 * factory. This keeps the vocabulary package pure while still letting a
 * descriptor carry the routing intent.
 */
export interface BackendDescriptor {
  /** The wire/DB backend id. Unique in the registry. */
  readonly id: BackendId;
  /** The account-label predicate this backend serves (its side of the pairing). */
  readonly servesLabel: (label: string) => boolean;
  /** The events-store `source` a step on this backend feeds. */
  readonly sourceName: string;
  /** Legal execution substrates (`'sdk'` and/or `'pty'`). */
  readonly substrates: readonly Substrate[];
  /** True for the three seed built-ins (immutable, may not be re-registered). */
  readonly builtin: boolean;
  /** Optional stable key the core layer maps to the concrete adapter factory. */
  readonly adapterFactoryKey?: string;
  /** Optional stable key the core layer maps to the concrete health probe. */
  readonly healthProbeKey?: string;
}

/**
 * The three built-in descriptors. Each reproduces the pre-ICR-0016 hardcoded
 * behaviour EXACTLY:
 *   - claude_code serves the open Claude-account form (MAX_<X> + ENT), feeds the
 *     `claude-otel` attribution-truth source, and is the ONLY pty-eligible
 *     backend (blueprint §4.1 — attended sessions are Claude-only).
 *   - opencode serves AWS_DEV, feeds `opencode-sse`, sdk-only.
 *   - lmstudio serves LOCAL, feeds `lmstudio`, sdk-only.
 *
 * `sourceName` mirrors the former `sourceForBackend` in core/pipelines/
 * lineageCost.ts verbatim so the events pane is unchanged.
 */
export const BUILTIN_BACKEND_DESCRIPTORS: readonly BackendDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'claude_code',
    servesLabel: (label: string) => isClaudeAccountLabel(label),
    sourceName: 'claude-otel',
    substrates: Object.freeze(['sdk', 'pty'] as const),
    builtin: true,
  }),
  Object.freeze({
    id: 'opencode',
    servesLabel: (label: string) => label === 'AWS_DEV',
    sourceName: 'opencode-sse',
    substrates: Object.freeze(['sdk'] as const),
    builtin: true,
  }),
  Object.freeze({
    id: 'lmstudio',
    servesLabel: (label: string) => label === 'LOCAL',
    sourceName: 'lmstudio',
    substrates: Object.freeze(['sdk'] as const),
    builtin: true,
  }),
] as const);

/**
 * Thrown by {@link registerBackend} when a descriptor is malformed or collides
 * with an already-registered id / label — the typed-refusal convention. A
 * registration failure is a programmer/config error, surfaced loudly.
 */
export class BackendRegistrationError extends Error {
  override readonly name = 'BackendRegistrationError';
}

/** The live registry: id → descriptor. Seeded with the three built-ins. */
const BACKEND_REGISTRY = new Map<string, BackendDescriptor>(
  BUILTIN_BACKEND_DESCRIPTORS.map((d) => [d.id, d]),
);

/**
 * Return the REGISTERED NON-BUILT-IN descriptor whose `servesLabel` accepts
 * `label`, or `undefined`. Built-in labels are resolved by their own
 * authoritative predicates elsewhere ({@link isClaudeAccountLabel} etc.), so
 * this only surfaces labels a fourth backend added — keeping built-in behaviour
 * byte-identical and making a descriptor unable to shadow a built-in label.
 */
function registeredBackendServingLabel(label: string): BackendDescriptor | undefined {
  for (const descriptor of BACKEND_REGISTRY.values()) {
    if (!descriptor.builtin && descriptor.servesLabel(label)) return descriptor;
  }
  return undefined;
}

/**
 * Register a backend descriptor (ICR-0016). Idempotent for an identical
 * re-registration of a non-built-in id; refuses (a) a built-in id, (b) a
 * conflicting id already bound to a DIFFERENT descriptor, (c) a `servesLabel`
 * that overlaps ANY built-in label form (so a descriptor can never hijack
 * MAX_<X>/ENT/AWS_DEV/LOCAL), and (d) a malformed descriptor. This is the ONE
 * seam a new-backend author touches — after this call `isBackend(id)` is true,
 * `backendForLabel(itsLabel)` routes to it, and the schema/app dispatch resolve
 * through the registry with no literal edits.
 */
export function registerBackend(descriptor: BackendDescriptor): void {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    typeof descriptor.id !== 'string' ||
    descriptor.id.length === 0 ||
    typeof descriptor.servesLabel !== 'function' ||
    typeof descriptor.sourceName !== 'string' ||
    descriptor.sourceName.length === 0 ||
    !Array.isArray(descriptor.substrates)
  ) {
    throw new BackendRegistrationError(
      `malformed backend descriptor: ${JSON.stringify({ id: descriptor?.id })}`,
    );
  }
  if (descriptor.builtin) {
    throw new BackendRegistrationError(
      `cannot register a descriptor flagged builtin (id ${descriptor.id}); the three built-ins are pre-seeded`,
    );
  }
  if ((BACKENDS as readonly string[]).includes(descriptor.id)) {
    throw new BackendRegistrationError(
      `cannot re-register the built-in backend id ${descriptor.id}`,
    );
  }
  const existing = BACKEND_REGISTRY.get(descriptor.id);
  if (existing !== undefined && existing !== descriptor) {
    throw new BackendRegistrationError(
      `backend id ${descriptor.id} is already registered by a different descriptor`,
    );
  }
  for (const substrate of descriptor.substrates) {
    if (!(SUBSTRATES as readonly string[]).includes(substrate)) {
      throw new BackendRegistrationError(
        `backend ${descriptor.id} declares unknown substrate ${JSON.stringify(substrate)}`,
      );
    }
  }
  // A descriptor may not claim any built-in label — those forms are owned by
  // claude_code/opencode/lmstudio and their pairing is frozen.
  for (const builtinDescriptor of BUILTIN_BACKEND_DESCRIPTORS) {
    // Probe the two open-form built-ins + the two fixed labels for overlap.
    for (const probe of ['MAX_A', 'MAX_Z', 'ENT', 'AWS_DEV', 'LOCAL']) {
      if (builtinDescriptor.servesLabel(probe) && descriptor.servesLabel(probe)) {
        throw new BackendRegistrationError(
          `backend ${descriptor.id} servesLabel overlaps built-in label ${probe} ` +
            `(served by ${builtinDescriptor.id}); a descriptor may not hijack a built-in label`,
        );
      }
    }
  }
  BACKEND_REGISTRY.set(descriptor.id, Object.freeze(descriptor));
}

/**
 * Remove a NON-built-in backend from the registry (test/teardown hygiene). The
 * three built-ins may never be unregistered. Returns true iff a descriptor was
 * removed. Tests that register a synthetic backend call this in cleanup so the
 * registry does not leak across specs.
 */
export function unregisterBackend(id: string): boolean {
  const existing = BACKEND_REGISTRY.get(id);
  if (existing === undefined) return false;
  if (existing.builtin) {
    throw new BackendRegistrationError(`cannot unregister the built-in backend id ${id}`);
  }
  return BACKEND_REGISTRY.delete(id);
}

/** The descriptor for `id`, or `undefined` when `id` is not registered. */
export function backendById(id: string): BackendDescriptor | undefined {
  return BACKEND_REGISTRY.get(id);
}

/**
 * All registered backend descriptors, built-ins first in seed order then any
 * registered additions in registration order. Deterministic for enumeration
 * (UI backend chips, schema CHECK derivation, diagnostics).
 */
export function allBackends(): readonly BackendDescriptor[] {
  const builtins = BUILTIN_BACKEND_DESCRIPTORS;
  const extras = [...BACKEND_REGISTRY.values()].filter((d) => !d.builtin);
  return Object.freeze([...builtins, ...extras]);
}

/** The registered backend ids, deterministic order (built-ins first). */
export function allBackendIds(): readonly string[] {
  return Object.freeze(allBackends().map((d) => d.id));
}

/**
 * The events-store `source` a step on `backend` feeds, resolved through the
 * registry (ICR-0016). REPLACES the hardcoded `sourceForBackend` if-chain that
 * lived in core/pipelines/lineageCost.ts — byte-identical for the built-in
 * three (claude_code → `claude-otel`, opencode → `opencode-sse`, lmstudio →
 * `lmstudio`). Throws {@link UnknownBackendError} for an unregistered id.
 */
export function sourceForBackend(backend: string): string {
  const descriptor = BACKEND_REGISTRY.get(backend);
  if (descriptor === undefined) throw new UnknownBackendError(backend);
  return descriptor.sourceName;
}

/**
 * True iff `substrate` is legal for `backend` per its descriptor (ICR-0016).
 * The registry form of the pty-is-claude-only rule: `substrateLegalFor('pty',
 * 'opencode')` is false, `substrateLegalFor('pty', 'claude_code')` is true.
 * Returns false for an unregistered backend (fail-closed).
 */
export function substrateLegalFor(substrate: string, backend: string): boolean {
  const descriptor = BACKEND_REGISTRY.get(backend);
  if (descriptor === undefined) return false;
  return (descriptor.substrates as readonly string[]).includes(substrate);
}

/**
 * Thrown by {@link sourceForBackend} when handed an unregistered backend id —
 * the typed-refusal convention (callers gate with {@link isBackend} first).
 */
export class UnknownBackendError extends Error {
  override readonly name = 'UnknownBackendError';
  constructor(backend: unknown) {
    super(`unknown backend ${JSON.stringify(backend)} (not a registered BackendDescriptor id)`);
  }
}
